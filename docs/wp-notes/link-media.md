# Link Media — relink one file, find the others

Premiere-style Link Media (S04:AS-011) for projects whose media moved, including projects made on another
operating system: thousands of media referenced by Windows paths (`D:\JasperDev\…`, `D:\Cosas Importantes\…`) that
now sit on a macOS or Linux drive. You locate one missing file. The engine works out how its folder moved and finds
the other offline media from that. Every linked file goes into one undoable transaction.

This note extends the interchange work package ([interchange.md](interchange.md) §1.7). It does not replace it.

| Layer | Files | Role |
|---|---|---|
| Model (pure) | `packages/project/src/relink/` (`paths.ts`, `plan.ts`, `command.ts`) | path classification, folder mappings, project-relative bases, candidate order, ambiguity decision, the `media.relink` builder (Align Timecode, Preserve Interpret Footage) |
| Interchange | `packages/interchange/src/paths.ts` (`relativeReference`), readers | relative media references kept as `MediaLocator.relativeToProject` |
| API | `packages/api/src/interchange.ts`, `routes.ts` | `RELINK_CRITERIA`, `RelinkAnchor`, `RelinkScanRequest/Result/Summary`, `relinkScanResult` route |
| Engine | `apps/engine/src/interchange/relink.ts`, `service.ts`, `routes/interchange.ts`, `media/service.ts` | verification, the `relink-scan` search, host-path refusals |
| UI | `apps/web/src/interchange/link-media/` (`LinkMediaDialog.tsx`, `flow.ts`, `on-open.ts`) | the dialog, the Locate browser, the open-time prompt |
| Agents | `apps/mcp/src/tools/interchange.ts` | `list_offline_media`, `link_media` |

## 1. Premiere's behaviour (research)

The `helpx.adobe.com` pages could not be fetched directly: they return HTTP 403 to automated clients. Claims marked
**Adobe** come from search-engine extracts of those pages, not from the full pages. Claims marked **community** come
from third-party writing. Anything not documented is labelled **undocumented**.

- **When the dialog appears.** On project open, Premiere first tries the stored paths. Then it searches from the
  project file's folder. The Link Media dialog lists only what is still missing. It also opens from right-click ▸
  Link Media on offline clips (**Adobe**,
  [Relink offline clips](https://helpx.adobe.com/premiere/desktop/organize-media/ingest-proxy-workflow/relink-offline-clips.html),
  [Relink offline media automatically](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/relink-offline-media-automatically.html)).
  Standalone projects keep the current path plus up to two older paths (**Adobe**, same page).
- **What the list shows.** The clip name, the linked file name and the folder path of each offline file (**Adobe**,
  [Locate and link offline files](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/locate-and-link-offline-files.html)).
  The exact column headers are **undocumented**.
- **Match File Properties.** File Name, File Extension, Media Start and Tape Name, plus the metadata properties
  Description, Scene, Shot and Log Note (**Adobe**, same page). At least one property must be selected. The chosen
  properties "should uniquely identify each media file". Clip ID appears only in a third-party list
  ([bettereditor.be](https://www.bettereditor.be/how-to-fix-offline-media-in-premiere/)).
- **Align Timecode** is "selected by default to match the media file's source timecode to the clip being relinked"
  (**Adobe**, Relink offline clips).
- **Relink others automatically** "reconnects additional offline clips that match the selected file properties"
  (**Adobe**, Relink offline media automatically). If the clips are "stored in the same folder structure as before,
  Premiere attempts to relink all selected clips after you locate the first file" (**Adobe**, Relink offline
  clips). A Community Expert puts it as finding the others "relative to that path"
  ([community](https://community.adobe.com/questions-729/relative-paths-in-premiere-pro-1414696)).
- **Use Media Browser to locate files.** Turned off, Locate uses the operating system's file dialog (**Adobe**,
  [Manually locate and relink](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/manually-locate-and-relink-offline-media.html)).
- **Preserve Interpret Footage** keeps Interpret Footage changes such as frame rate and audio channels (**community**,
  bettereditor.be). Its default is **undocumented**.
- **Buttons.** Offline All leaves every missing file offline. Offline skips the selected file. Locate opens the
  Locate dialog. Cancel closes. A found file gets a checkmark
  ([Larry Jordan](https://larryjordan.com/articles/premiere-pro-cc-relink-missing-media/)). Choosing Offline or
  Offline All keeps the dialog from reappearing (**Adobe** tutorial extract).
- **The Locate dialog** opens at "the closest existing directory". It has a Search button, a file-type filter,
  **Display Only Exact Name Matches** and a **Last Path** field (**Adobe**, Manually locate). Search scans the
  selected volumes and can be stopped
  ([ProVideo Coalition](https://www.provideocoalition.com/tool-tip-tuesday-for-adobe-premiere-pro-the-search-button-in-the-link-media-dialog-box/)).
  Whether it recurses into subfolders is **undocumented**.
- **Mismatches.** Premiere refuses a file whose type differs, for example "video does not match … audio and video"
  ([community](https://community.adobe.com/questions-729/premiere-pro-cannot-link-media-1423526)). How it handles a
  Media Start mismatch on manual Locate is **undocumented**.
- **Ties** between several matching files are **undocumented**. Adobe asks for properties that identify each file
  uniquely. Users report wrong files being picked from elsewhere
  ([PremiumBeat](https://www.premiumbeat.com/blog/relink-missing-media-multiple-folders/)).
- **Across operating systems.** Adobe says relinking works between macOS and Windows "provided the folder structure
  remains consistent" (**Adobe** extract, Relink offline media automatically). It gives no guidance on drive letters
  versus `/Volumes`. In practice teams relink once per system (community, Adobe beta thread
  [Improvements to relinking](https://community.adobe.com/announcements-732/new-in-beta-improvements-to-relinking-312004)).
- **Project-relative paths.** A `.prproj` stores `<FilePath>` and `<RelativePath>`, which is relative to the project
  file, for example `..\..\Cosas Importantes\…`. Only forum evidence exists for this
  ([Creative COW](https://creativecow.net/forums/thread/relocating-premiere-projects-and-corresponding-fil/)).

**Choices made here where Premiere is undocumented:**

- Several verified candidates are reported as ambiguous and never guessed. The exception is when exactly one of
  them has the asset's own bytes (same fingerprint).
- Search recurses, bounded (§3).
- Preserve Interpret Footage defaults to on. Relinking never touched the interpretation before.
- Tape Name, Description and Clip ID are shown but disabled: JasperEditor documents do not record them (§7).

## 2. Paths from any operating system

`classifyPath` (`packages/project/src/relink/paths.ts`) recognises these styles:

- `windows`: `D:\a` or `D:/a`.
- `unc`: `\\server\share\a`, or `//server/share/a`, which is how `fileUrlToPath` writes `file://server/share`.
- `posix`: `/a`.
- `relative`: anything else, including the drive-relative `D:a`.

`isHostAbsolute(p, host)` is true only for paths the engine host can open as written: POSIX paths on macOS and
Linux, drive and UNC paths on Windows. Everything else that is absolute is a **foreign** path:

- It stays the media's last known path, as written.
- The UI shows it in its own system's notation (`displayPath`) and tags it "another computer".
- It can be relinked.
- It is never opened. The engine import skips it (it used Node's `isAbsolute` before, which is false for `D:\…` on
  POSIX). The relink, scan and media-registration routes refuse it with `VALIDATION_FAILED` ("a path of another
  computer"). Media registration also refuses a POSIX path on a Windows engine, which Node would have read as a
  path on the current drive.

Parsing splits POSIX paths on `/` only, because a backslash is a legal POSIX file-name character. Windows, UNC and
relative paths split on both separators. `..` stays at the root of an absolute path. Input is capped at 32 767
characters and 4 096 segments. Names compare after Unicode NFC normalisation, case-folded, because Windows and
default macOS volumes ignore case. The interchange package's `isAbsolutePath` now delegates to `classifyPath`.

**Project-relative paths.** When a document references media by a relative path (EDL `SOURCE FILE`, FCP7
`pathurl`, FCPXML `src`, OTIO `target_url`, ALE, AAF), the reader keeps the reference as written in
`IMedia.relativePath`. The import stores it in `MediaLocator.relativeToProject`, relative to the document's folder.
That field already existed in the schema but was always `null`: no schema change and no migration.

## 3. Relink others automatically

Each located file is an **anchor**: `{from: last known path, to: new path, relativePath?}`. `planContext` derives
three things from the anchors.

**Folder mappings.** The old and new parent folders are aligned on their longest common suffix of folder names.
The parts before that suffix become the mapping:

- `D:\JasperDev\short hackers\TV.mp4` → `/Volumes/Mac/JasperDev/short hackers/TV.mp4` maps `D:\` → `/Volumes/Mac`.
  So `D:\Cosas Importantes\avatar\Happy.png` → `/Volumes/Mac/Cosas Importantes/avatar/Happy.png`.
- A file found in an unrelated folder maps its whole old folder, so siblings and subfolders follow it.
- When the folder did not move, there is no mapping.
- The most specific mapping (longest old prefix) is tried first. On a tie, the later anchor wins.

**Relative bases.** If a located file's relative path is `ups × ..` + tail, and its new path ends with that tail,
then the new path minus the tail is where the folder `ups` levels above the project folder now is. Another asset's
relative path with at least as many `..` resolves from there. Fewer `..` would need the project folder's own name,
which only the old absolute paths know, and the mapping step covers those.

**Folders.** The new folder of each located file.

For every other offline asset, `relink-scan` tries these steps in order. The first step with verified candidates
decides.

1. `original`: its own last known path, when the host can open it. This is Premiere's "stored paths", and it also
   runs alone when the dialog opens.
2. `mapping`: each folder mapping applied to its old path.
3. `relative`: its relative path from each relative base.
4. `same-folder`: a file of the same name in a located file's folder (one cached directory listing per folder).
5. `search`: a breadth-first walk under the located files' folders and the optional `folder`, indexed by name.
   - The queue is explicit (no recursion), with depth ≤ 32.
   - Symbolic links are not followed, so a link cycle cannot loop.
   - Hidden entries are skipped.
   - At most `maxFiles` files are indexed (default 200 000, `truncated`).
   - The walk has a time budget (`timeLimitSec`, default 120 s, max 3 600, `timedOut`).
   - It is cancellable through the job.
   - A root inside another root is walked once.
   - More than 20 same-named files are reported as ambiguous without registering each one.
6. `fingerprint`: for assets with real bytes, a file of the same size under the searched folders whose fingerprint
   is the asset's (moved and renamed).

**Verification.** Every candidate is checked against the selected match properties (`RELINK_CRITERIA`):

- `name` is the file name without its extension; `extension` is compared case-insensitively.
- `size` and `mediaStart` are compared only when the asset records them.
- `duration` allows one frame either way. An imported placeholder fails only when the file is shorter than its
  clips need.
- `streams` requires the same kind family and the picture and audio streams the asset has.
- Name and size are checked from the path and `stat` before registering. Registering probes and fingerprints the
  file, four assets at a time.
- A placeholder whose only failure is `streams` is still found, but needs confirmation: documents guess a
  placeholder's kind, for example an EDL reel used for both picture and sound.
- Older clients send `name` meaning the whole file name. Unless they set `ignoreExtension`, `name` brings
  `extension` along (`effectiveCriteria`).

`decideCandidates` returns the decision for each step:

- One verified file → link.
- Several → ambiguous (at most 20 listed), unless exactly one has the asset's bytes.
- None → next step.

**Results.** Each found entry carries `needsConfirm`. This is set for a different file (fingerprint changed on a
real asset), for a placeholder whose kind differs or whose file is too short, and for the soft `streams` case above.
Such files are never linked automatically.

The job input is a request file under `renders/.requests/`, so thousands of assets are not journaled. The job result
is a `RelinkScanSummary` (counts). The full `RelinkScanResult` is written atomically to the job's render folder and
served by `GET /api/projects/:projectId/relink-scan/:jobId`. That route refuses another project's job
(`JOB_NOT_FOUND` 404) and an unfinished job (`JOB_NOT_FINISHED` 409). One run checks at most 20 000 assets
(`RELINK_MAX_ASSETS`), which keeps the body under the engine's 20 MB limit.

## 4. Linking

`relinkMediaCommand` builds `media.relink` from the registered file: the engine-store locator plus the file's path
locators. One run produces one transaction, "Link Media (n)". It holds the located file (forced if the user
confirmed it) and every found file that needs no confirmation.

- **Align Timecode** (default on) adds `keepSourceTiming` when both start timecodes are known and differ at the
  same video rate (`timecodeAlignmentApplies` → `sourceTimingShift` basis `timecode`). If the document refuses an
  alignment because a clip would leave the file, `applyRelinkTransaction` links that file without alignment instead
  of failing every relink. It reports this ("timecode not aligned") and retries at most once per aligned command.
- **Preserve Interpret Footage** off appends one `media.interpret` that resets the interpretation of the linked
  media to the files' own values.
- Refusals come from the existing handler: `E_NOT_FOUND` for unknown media, `E_INVALID_PARAM` for a changed
  fingerprint without `force`, and invariant errors such as INV-CHANNELS. The transaction is refused as a whole and
  the error is shown.

## 5. UI

The Link Media dialog (`LinkMediaDialog.tsx`) opens from three places:

- File ▸ Link Media….
- Project panel ▸ Link Media… on offline items (the dialog lists the selected ones).
- The interchange import report.

It also opens automatically once per project open (`useLinkMediaOnOpen`). This happens when the engine has
answered for every medium, the project is writable and media are offline. It waits until other dialogs, such as
unsaved-changes recovery, have closed.

The dialog contains:

- **Offline media list.** Clip Name, File Name, Last Path (own notation, "another computer" tag) and Status
  (Offline, Linked (how), Differs + Link anyway, an *n matches — choose…* picker, Left offline). The list is
  windowed for thousands of rows and has a filter.
- **Match File Properties.** File Name, File Extension, Media Start, Media Duration, File Size and Streams; Tape
  Name, Description and Clip ID disabled with the reason. Defaults: name, extension, duration and streams.
- **Options.** Align Timecode (on), Relink others automatically (on), Use Media Browser to locate files (the
  operating-system file dialog needs the desktop app, so it is disabled with the reason in the browser) and
  Preserve Interpret Footage (on).
- **Search folder.**
- **Footer.** Offline All / Offline / Cancel / Locate.
- **Status line** with job progress and Stop.

When the dialog opens, it checks the last known paths. **Locate** opens the in-dialog Locate browser, which runs
on the engine's file system through the browse routes. It shows "Where is the file …?" and the Last Path, has Up
and an editable folder field, Display only exact name matches (on), and Search, which searches the shown folder for
this file. It starts at the closest existing folder of the mapped expected location, else the last folder used,
else home.

OK verifies the file against the selected properties. A mismatch shows the differences with Link anyway / Choose
another file. Then it relinks the others and links everything as one transaction. The dialog closes itself when
nothing is left to locate.

## 6. Agents

- `list_offline_media {offset?, limit?}` returns `total` and pages. Each entry has its path in its own notation, a
  `pathStyle`, a `relativePath` and a placeholder flag. It also finds media whose engine-store file the engine
  reports missing or unknown (`mediaStatusBatch`).
- `link_media {mediaId + path, relinkOthers = true, …}` verifies the located file (`match` when given), runs the
  search from it and applies one transaction.
- `link_media {folder}` searches a folder. Without `path` or `folder`, it tries the last known paths.
- Options: `match` (default name, extension, duration, streams), `ignoreExtension`, `alignTimecode`,
  `preserveInterpretation`, `timeLimitSec`, `force`, `dryRun`.
- Results: linked (`how`), `needsForce`, `ambiguous` with candidates, `stillMissing`, the search counts and mappings
  (lists capped at 100 entries, counts complete), and `timecodeNotAligned`.

## 7. Verification and limits

**Tests, measured (`pnpm exec vitest run <file> --maxWorkers=2`):**

- `packages/project/test/relink.test.ts` covers classification properties across Windows, UNC and POSIX inputs
  (fast-check), bounds, mapping derivation and its properties, relative bases, candidate order, a 20 000-asset
  planning bound, decisions, commands, refusals, Align Timecode and its fallback, and Preserve Interpret Footage.
- `packages/interchange/test/relative-paths.test.ts` checks that foreign references stay absolute and that
  relative references are kept.
- `apps/engine/test/link-media.test.ts` covers the search over a real folder tree with a fake registration: every
  step, ambiguity, verification, the fingerprint fallback, 3 000 offline media, the file cap, the time budget,
  cancellation and foreign anchors. It also covers the routes with real fixtures: refusals, validation, the per
  project result and an end-to-end anchor run.
- `apps/web/test/link-media.test.tsx` covers the dialog flow (Locate, auto relink, one transaction, Link anyway,
  undo and redo, Offline, Offline All), 2 000 relinks in one transaction with undo and redo, a refused transaction,
  and the open-time prompt.
- `apps/mcp/test/interchange.test.ts` covers paging, path style, and `link_media` with relinkOthers.

**Exercised in the running app** (engine 47915, vite 5185, Linux):

1. An EDL imported with Windows paths came in as five placeholders, tagged "another computer".
2. The generated media sat in `/tmp/…/Mac/JasperDev/short hackers/…` and `/tmp/…/Mac/Cosas Importantes/…`.
3. Locating `TV static.mp4` linked it, `Happy.mp4` (Same folder structure) and `buried.mp4` (Search, it had moved
   from `E:\Old Exports`) in one step.
4. Reopening the project opened the dialog by itself for the two still offline.
5. A folder search found `sans.wav` as "Differs" (the EDL guessed a picture stream). Link anyway was refused by
   INV-CHANNELS and the error was shown; nothing else changed.

**Limits:**

- Tape Name, Description, Scene, Shot, Log Note and Clip ID cannot be matched: documents do not record them.
- A placeholder whose guessed stream layout differs from the real file (an EDL source used for picture and sound
  that is really audio only) cannot be linked. Its clips' channel mappings name streams the file lacks
  (INV-CHANNELS), and remapping them is not implemented.
- The engine's registry is content-addressed. Two byte-identical files share one record, so a relinked asset may
  carry the first file's name and path. The bytes are the same.
- The walk is bounded: a tree over 200 000 files or 120 s is searched partially, and the result says so.
- One run checks at most 20 000 offline media.
- The MCP `link_media` transaction carries every command in one request (≈ 1–1.5 KB per file). Very large runs
  approach the 20 MB request limit (estimate from probe sizes, not measured).
- There is no `.prproj` importer yet. A future one should set `IMedia.relativePath` from `<RelativePath>`.

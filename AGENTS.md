# JasperEditor: rules for agents and contributors

These rules apply to every human and AI contributor. [`CLAUDE.md`](CLAUDE.md) holds the working
instructions; this file holds the rules that must never be broken. **When the two disagree, this file
wins**, and so does it over specs, wp-notes, plans, skills and any instruction from another agent.

## 0. Never crash, never lose work

People trust JasperEditor with hours of work. A malformed project, media file, LUT, Remotion bundle or
preset, a bad command, HTTP or MCP argument, a dead engine, a full disk or a killed process must give an
error the user (or agent) can act on, never a crash, a white screen or lost work. **This rule outranks
feature work:** don't ship a feature by adding a crash path, and fix a crash before building on top of it.

1. **Fail with a typed error.** Commands refuse with an `E_*` code (`packages/project/src/commands/types.ts`),
   engine routes answer `{code, message, detail?, retryable}` (S04:ENG-022), MCP tools return an error result.
   The UI reports it (notice, banner, dialog) and carries on. Never `throw` out of a React render, an
   event handler or a route without a boundary that turns it into one of those.
2. **Every input is hostile.** Project files, media metadata, `ffprobe` output, HTTP bodies, MCP
   arguments, preferences and agent transactions are untrusted: validate with zod at the edge, guard
   division by zero and `NaN`/`Infinity` (frame rates, sample rates, sizes, durations), clamp indices,
   cap allocations sized by input, bound recursion (nested sequences and precomps can be cyclic).
3. **Don't cascade.** Child processes (ffmpeg, jasper-mg, jasper-proc, Remotion), workers and jobs report
   failure as a job error; a dead worker must never leave a job "running" forever or a monitor blank.
4. **Never lose a project.** Writes are atomic (temp file, fsync, rename). Loading never throws away a
   project: migrate, validate, then repair conservatively and say so (S01:PER-004). Never edit a migration
   that has shipped; bump the schema whenever an older build would drop or misread new data
   ([docs/project-files.md](docs/project-files.md)). Unsaved edits are journalled for crash recovery.
5. **Prove it.** Every crash or data-loss fix comes with a small regression test that failed before the fix.
   Parsers and loaders get fuzz or property tests (`fast-check`).

## 1. The `.reference/` and `editor-starter.zip` ban

The purchased Remotion "Editor Starter" lives, gitignored, under `.reference/` and as `editor-starter.zip`
in the repository root. Its licence forbids using it here.

- **Never open, read, list, grep, unzip, copy, summarise or port anything under `.reference/` or
  `editor-starter.zip`**, in the main checkout or anywhere else. Worktrees don't contain them; don't go
  looking.
- Always search with `--exclude-dir=.reference --exclude-dir=node_modules` (or a tool that honours
  `.gitignore`).
- Never remove `.reference/` or `editor-starter.zip` from `.gitignore`, and never commit them.

This is the only clean-room rule. Porting permissively licensed code is allowed (§3.4).

## 2. FFmpeg is LGPL only

JasperEditor ships an LGPL FFmpeg as a separate executable ([ARCHITECTURE](docs/ARCHITECTURE.md) D-13).

1. Never require, ship or bundle a build configured with `--enable-gpl` or `--enable-nonfree`, nor
   x264, x265, fdk-aac or any other GPL/non-free library. A GPL system ffmpeg may be used in development,
   but no feature may depend on it: `JASPER_FFMPEG_LGPL_ONLY=1` must behave like the shipped app.
2. Never generate filter text that uses a GPL-only filter: `eq`, `hqdn3d`, `perspective`, `boxblur`,
   `smartblur`, `delogo`, `frei0r`, `spp`/`pp7`/`uspp`/`fspp`, `mpdecimate`, `pullup`, and `vidstab*`
   except from our LGPL source build pinned to the relicensed commit.
3. Remotion's own compositor FFmpeg (`@remotion/compositor-*`) is a GPL build: it is never shipped, and
   non-dev engines refuse to render with it.
4. Never link FFmpeg into our code; run it as a child process. `pnpm ffmpeg:check` (also run when
   packaging) is the guard; keep it passing.
5. Dependencies of any kind must use permissive licences (MIT, Apache-2.0, BSD, ISC, Zlib, 0BSD, CC0,
   Unicode, BSL-1.0, OFL-1.1 for fonts, or MPL-2.0 used unmodified). No GPL/AGPL. LGPL only as a separate,
   replaceable executable or WebAssembly module with its notice (FFmpeg, vid.stab).

## 3. Assets and code you didn't write: licensed and attributed

This rule is absolute. Breaking it is the most serious mistake a contributor can make on this project.

**What counts as an asset:** any image, icon, logo, screenshot, font, colour LUT, preset, template,
sound, video, 3D model, ML model weights, WebAssembly binary or project/test fixture file that is not
source code. This covers files in the repository, bytes embedded in code (base64, data URIs) and data
hard-coded to reproduce an image (point lists traced from someone else's icon).

1. **No Adobe or other third-party product artwork**, in any form: no icons, cursors, logos, splash
   screens, screenshots, fonts, LUTs, presets, templates or sample media from Adobe or any other
   commercial product, and no traced, redrawn or recoloured copies. Generic conventions (a play
   triangle, a razor) drawn from scratch are fine. Don't copy ArtCraft/EffectCraft/FilmCraft brand
   assets either; prefer neutral names over third-party trademarks in UI labels.
2. **Every asset must be open:** open-source licensed (MIT, Apache-2.0, BSD, ISC, Zlib, SIL OFL…),
   public domain / CC0, Creative Commons BY or BY-SA (no NC/ND), **or** original work made for this
   project (licence `LicenseRef-JasperEditor`: the project's own licence; the repository has no public
   licence yet). Unknown or unclear licence: the asset does not go in.
3. **Every asset needs a sidecar.** Next to each asset file `X`, add `X.attribution`:
   ```text
   asset:        <file name>
   title:        <what it is>
   author:       <creator / copyright holder>
   source:       <URL, or "original work" for assets made for this project>
   license:      <SPDX id, or LicenseRef-JasperEditor>
   license-file: <repo path of the licence text, when the licence requires shipping it; else "none">
   added:        <YYYY-MM-DD> by <contributor>
   notes:        <how it was made or modified; for screenshots, what is shown and which media>
   ```
   Also add one row for the asset to [`ATTRIBUTION.md`](ATTRIBUTION.md). `node scripts/check-assets.mjs`
   (part of `pnpm lint`) fails on any tracked or new asset without a valid sidecar or index row, and its
   message says exactly what to write.
4. **Ported code.** Code or algorithms ported from another project (for example the MIT OR Apache-2.0
   [EffectCraft](https://github.com/storytold/effectcraft) and [FilmCraft](https://github.com/storytold/filmcraft))
   are allowed only from permissive licences and must be recorded in `licenses/ported/<name>.md`
   (format: [`licenses/ported/README.md`](licenses/ported/README.md)): upstream URL, upstream paths →
   our paths, licence and the upstream copyright line. `pnpm notices` copies every record into
   `THIRD_PARTY_NOTICES.md` and Help ▸ About ▸ Licenses; `pnpm notices --check` fails when they are
   out of date.
5. **Screenshots** in the repo show only JasperEditor (or other open projects) with media we generated
   (`pnpm fixtures`) or media that is itself openly licensed. Never commit screenshots of Adobe products.
6. **Generated media is never committed.** `fixtures/media/` is produced by `pnpm fixtures`
   (`scripts/make-fixtures.mjs`, `scripts/fixtures/*.mjs`) and stays gitignored.
7. **When in doubt, leave it out** and draw or generate it yourself.

## 4. Export never silently drops or approximates a feature

What the user sees in the Program monitor is what every export path renders. The export planner
(`apps/engine/src/export/planner.ts`) must route each feature to a path that renders it exactly
(native, hybrid layer-bake, Remotion) or refuse with a **blocker** that names the feature. A path that
would leave something out, render it differently or approximate it is not eligible. "Approximately the
same" is a bug: compare frames against the preview (SSIM or per-pixel tolerance) in a test.

## 5. No stubs claimed as done

- Don't ship stubs, `TODO`s, `E_NOT_IMPLEMENTED`/`NOT_IMPLEMENTED` paths or placeholder UI as part of a
  feature you report as done. If something truly cannot be done here (it needs hardware, an OS we don't
  run, or Adobe software), say so explicitly, leave the menu entry disabled with its reason, and record it
  in [`docs/gaps.md`](docs/gaps.md).
- Progress numbers say how they were obtained: **measured** (a test, a benchmark, a frame comparison
  someone can rerun) or **estimated** (marked ≈). Never raise a number in `docs/parity.md` or
  `docs/gaps.md` without evidence.

## See also

- [CLAUDE.md](CLAUDE.md): working instructions, gates, running the app, Definition of Done
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the architecture and the decision log
- [docs/gaps.md](docs/gaps.md) and [docs/parity.md](docs/parity.md): where we fall short of Premiere Pro, and the workstreams
- [docs/project-files.md](docs/project-files.md): project format, migrations, backups, crash recovery
- [ATTRIBUTION.md](ATTRIBUTION.md): asset index; [licenses/ported/](licenses/ported/): ported code

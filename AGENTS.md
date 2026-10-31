# JasperEditor agent rules

- Use this file as the repository's agent operating manual; it takes precedence over
  conflicting repository docs, plans and agent notes.
- Keep other agent instruction files as pointers here, without duplicated rules.

## 0. Never crash or lose work

- Fix crash and data-loss paths before building features on them.
- Return command refusals as `E_*` codes from `packages/project/src/commands/types.ts`.
- Return engine errors as `{code, message, detail?, retryable}`.
- Return MCP failures as error results.
- Surface failures in the UI without crashing, blanking the editor or discarding work.
- Catch failures at render, event-handler and route boundaries and convert them to visible errors.
- Validate project files, media metadata, ffprobe output, HTTP bodies, MCP arguments,
  preferences and transactions with zod at their entry points.
- Guard division by zero and nonfinite numbers.
- Clamp indices to valid bounds.
- Cap allocations sized by untrusted input.
- Bound recursion and detect cycles in nested sequences and precompositions.
- Propagate child-process and worker failures into job errors; never leave dead jobs running.
- Write projects, versions, view state and journals atomically: same-directory temp file,
  fsync, rename, then directory fsync.
- Load through migration, validation and conservative repair; report repairs to the user.
- Preserve unsaved edits in the crash-recovery journal and respect writer leases and revisions.
- Never edit a shipped migration.
- Never downgrade a newer-schema project; open it read-only.
- Bump the schema whenever an older build would drop or misread new data, including optional fields.
- Coordinate concurrent schema changes so the integrated result has the required migration,
  fixture and compatibility tests before merge.
- Follow [project-file procedures](docs/project-files.md) for persistence or schema changes.
- Add a regression test that fails before every crash or data-loss fix.
- Use property/fuzz tests (`fast-check`) for parsers and loaders.

## 1. Prohibited reference material

- Never open, read, list, search, unzip, copy, summarize or port anything under `.reference/`
  or named `editor-starter.zip`, in this checkout or anywhere else.
- Use searches that honor `.gitignore`, such as `rg`; otherwise explicitly exclude
  `.reference/`, `editor-starter.zip` and `node_modules/`.
- Never remove these reference artifacts from `.gitignore` or commit them.

## 2. FFmpeg and dependencies

1. Never require or ship FFmpeg configured with `--enable-gpl` or `--enable-nonfree`,
   or using x264, x265, fdk-aac or another GPL/nonfree library. A GPL system FFmpeg is
   allowed for development only; features must work with `JASPER_FFMPEG_LGPL_ONLY=1`.
2. Never generate GPL-only filters: `blackframe`, `boxblur`, `boxblur_opencl`, `colormatrix`,
   `cover_rect`, `cropdetect`, `delogo`, `eq`, `find_rect`, `frei0r`, `frei0r_src`, `fspp`,
   `histeq`, `hqdn3d`, `interlace`, `kerndeint`, `mcdeint`, `mpdecimate`, `mptestsrc`, `nnedi`,
   `owdenoise`, `perspective`, `phase`, `pp`, `pp7`, `pullup`, `repeatfields`, `rubberband`,
   `sab`, `signature`, `smartblur`, `spp`, `stereo3d`, `super2xsai`, `tinterlace`, `uspp`,
   `vaguedenoiser`, `vidstabdetect` or `vidstabtransform`.
   The sole `vidstab*` exception is our manifest-pinned LGPL source build with provenance
   accepted by `scripts/ffmpeg/check-lgpl.mjs`.
3. Never ship Remotion's bundled GPL FFmpeg or `@remotion/compositor-*` packages.
   Use the verified LGPL binaries directory; non-dev engines must refuse the bundled GPL path.
4. Run FFmpeg as a separate executable; never link it into application code.
   Keep `pnpm ffmpeg:check` passing for FFmpeg and packaging changes.
5. Use permissive dependencies: MIT, Apache-2.0, BSD, ISC, Zlib, 0BSD, CC0, Unicode,
   BSL-1.0 or OFL-1.1; MPL-2.0 is allowed unmodified. No GPL/AGPL. LGPL is allowed only
   as a separate, replaceable executable or WebAssembly module with its notice.

## 3. Assets and ported code

1. Use only openly licensed assets, public-domain/CC0 assets, CC BY/BY-SA assets, or original
   work licensed `LicenseRef-JasperEditor`. Never add assets with unknown licences or NC/ND terms.
   Templates that replicate a platform's UI may use that platform's names, logos, icons and fonts.
2. Port code or algorithms only from permissive licences; record source URLs, upstream-to-local
   paths, licence and copyright in `licenses/ported/<name>.md` using the
   [record format](licenses/ported/README.md).
3. Commit screenshots only of JasperEditor or other open projects, with generated or openly
   licensed media.
4. Never commit generated `fixtures/media/`; add fixture recipes under `scripts/fixtures/`.
5. Leave out assets whose provenance cannot be established.

## 4. Preview and export fidelity

- Route each feature in `apps/engine/src/export/planner.ts` to a path that renders it exactly
  (native, hybrid layer bake or Remotion), or refuse with a blocker naming the feature.
- Never silently drop or approximate a feature on any export path.
- Compare export frames with Program preview using SSIM or per-pixel tolerances in tests.
- Keep audio processing consistent between preview and every export path.

## 5. Completion and evidence

- Don't report stubs, TODOs, `E_NOT_IMPLEMENTED` paths, placeholder UI or partial wiring as done.
- Disable genuinely unavailable actions with a reason and record them in [docs/gaps.md](docs/gaps.md).
- Label progress figures as measured with rerunnable evidence, or estimated with `≈` and a basis.
- Don't raise figures in [docs/parity.md](docs/parity.md) or the gaps document without evidence.
- Report benchmark machine, load and comparable before/after conditions.
- Record changed behavior, validation and remaining limitations in the relevant documentation.
- Cite researched behavior and formulas in the area's work note; label undocumented assumptions.
- Finish with what changed, checks actually run and any unresolved failures or limits.

## 6. Scope and code placement

- Inspect `git status`, the affected implementation and its tests before editing.
- Use pnpm and the pnpm/Node requirements in `package.json`.
- Install with `pnpm install --frozen-lockfile` unless intentionally updating dependencies.
- Read [README.md](README.md) for setup, app startup, CLI/MCP/HTTP usage and packaging commands.
- Follow the relevant layer contracts in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md);
  architecture decisions take precedence over conflicting specs in `docs/specs/`.
- Read only the area's relevant specs, `docs/wp-notes/` and tests; verify claims against code.
- Keep the pure document model, validation and serializable commands in `packages/project`.
- Make document edits undoable commands.
- Test undo/redo, refusals and invariants for command changes.
- Put session state and persistence coordination in `packages/session`.
- Put React UI, panels and UI-command dispatch in `apps/web`.
- Keep `apps/desktop` a shell around the shared web UI and engine.
- Put media services, jobs and HTTP routes in `apps/engine`.
- Put MCP tools in `apps/mcp`.
- Put shared render compositions in `packages/compositions`.
- Put native motion graphics in `native/mg`.
- Keep `packages/*` independent of `apps/*`; import cross-package code through declared exports.
- Preserve `scripts/check-layers.mjs` dependency boundaries and cycle checks.
- Use design tokens in UI code; `scripts/check-tokens.mjs` rejects raw palette classes and colors.
- Keep anime.js seek-driven through `@jasper/motion`; satisfy `scripts/check-anime.mjs`.
- When changing persisted behavior, update its schema, invariants and `repairDocument` together.
- When changing an editing feature, wire its applicable controls, menus and shortcuts without conflicts.
- Keep applicable MCP tools, guide resources and tool documentation aligned with behavior.

## 7. Verification

- Don't skip verification, weaken tests or suppress failures to make a change pass.
- During development, run affected tests with
  `pnpm exec vitest run <files> --maxWorkers=2` and `pnpm --filter <package> typecheck`.
- Before merging, pass `pnpm verify`: lint, typecheck, tests and build.
- On shared hosts, the equivalent gate is `pnpm lint && pnpm typecheck &&
  pnpm test --maxWorkers=2 && pnpm build`; cap workers rather than dropping tests.
- Follow [docs/testing.md](docs/testing.md) for required tooling, oracle, fuzz, GL and golden checks.
- Run the relevant specialized suites when changing behavior they cover; the default gate
  omits opt-in rendering, extended fuzz runs, Playwright, desktop and packaged-app suites.
- Use `JASPER_REQUIRE_ORACLES=1` for oracle validation; a missing oracle must not count as success.
- For shader changes, run GL tests with a working Chrome/software-GL environment.
- Exercise UI changes in the running app and inspect the result visually.
- For rendering changes, exercise preview and export and inspect extracted frames.
- Run `pnpm e2e` for browser integration; it prepares fixtures, binaries and required builds.
- Don't use `E2E_SKIP_BUILD=1` or direct Playwright runs unless required build outputs are current.
- Don't assume `pnpm build` builds Rust or the Remotion bundle; use `pnpm mg:build` and
  `pnpm --filter @jasper/engine build:remotion` when needed.
- Treat `pnpm mg:build` skipping because cargo is missing as untested native behavior.
- Don't bless changed golden outputs without inspecting and explaining the differences.
- State skipped suites and unavailable dependencies explicitly; don't claim they passed.

## 8. Generators and scripts

- Don't invent a script or command before checking root/package `package.json` and `scripts/`.
- Don't hand-edit generated files; edit their source and run the owning generator.
- Regenerate `THIRD_PARTY_NOTICES.md` with `pnpm notices` after dependency or port-record changes;
  commit the result and run `pnpm notices --check`.
- Generate test media with `pnpm fixtures`.
- Generate English and model-string catalogs with `pnpm i18n`.
- Update Spanish translations in `apps/web/src/i18n/es.json`; validate with `pnpm i18n:check`.
- Keep ignored builds, caches, downloaded binaries and runtime state out of commits.
- Inspect generator diffs and include only outputs required by the requested change.

## 9. Shared work and integration

- Give each editing agent a separate branch and worktree under `.claude/worktrees/<name>`.
- Don't edit another agent's worktree.
- Don't overwrite unrelated working-tree changes.
- Don't use shared `git stash`; preserve unfinished work in commits on the owning branch.
- Give simultaneous app stacks distinct ports and `JASPER_APPDIR` directories.
- Stop only processes you started.
- Use the pairing flow or existing test harness for authenticated app access.
- Don't hard-code authentication cookies; use the harness's port-scoped session setup.
- Don't bypass engine authentication or destructive-command approvals, even on localhost.
- Before integrating, fetch and merge the target branch; resolve conflicts without dropping
  either side's intended behavior or tests, then verify the integrated result.
- Stage only task-related changes and review the staged diff before committing.
- Update the integration checkout only when its work is preserved; prefer fast-forward integration.
- Don't rewrite shared history or force-push.
- Require explicit authorization for remote pushes, publishing, releases, signing, spending,
  credential disclosure or destructive shared-state changes; existing authorization is sufficient.
- Recheck changed agent instructions after remote integration against this file's maintenance rules.

## 10. Standing Don'ts

- Don't expand scope into unrelated fixes, refactors, dependency upgrades or product redesigns.
- Don't add redundant wrappers, speculative abstractions or parallel implementations of existing helpers.
- Don't reformat untouched files or run broad autofixes that obscure the requested change.
- Don't append history, changelogs, incident/PR notes, dates or temporary workarounds to this file.
- Don't preserve obsolete instructions as "we used to" explanations; delete them.
- Don't turn live traps into stories; state their current prohibition in the relevant section.
- Don't copy README or specialist documentation here; link the source once.
- Don't add version pins, feature counts or ownership rosters here; use their authoritative sources.
- Keep this manual to actionable current contracts, one idea per bullet, roughly 200–350 lines
  and always below 500; cut duplication before adding a rule.

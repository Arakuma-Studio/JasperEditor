# JasperEditor

A Premiere-style, agent-drivable video editor combining Remotion (preview and graphics renders), native
ffmpeg (probe, proxies, fast export) and fframes motion graphics. Web app, installable PWA and Electron
desktop all load the same SPA and talk to the same local engine.

Read `docs/ARCHITECTURE.md` first; functional specs live in `docs/specs/`, research in `docs/research/`.

## Requirements

- Node 20.19+ (tested on 20.20), pnpm 10 (`corepack enable` or `npm i -g pnpm@10`)
- ffmpeg/ffprobe on `PATH` (system 6.x is fine) for fixtures and the engine
- Optional: cargo for the `jasper-mg` motion-graphics renderer (WP-2G)

## Getting started

```bash
pnpm install
pnpm fixtures        # generates fixtures/media/{clip-a.mp4, clip-b.mp4, tone.wav, still.png, phone-rot90.mp4}
pnpm dev             # engine on http://127.0.0.1:47900 + web on http://127.0.0.1:5173 (proxied, same origin)
```

Open http://127.0.0.1:5173. The Home screen lists projects from the engine; "Open demo project" opens an
in-memory project in the placeholder shell while the engine project store is being built.

## Scripts

| Script | Does |
|---|---|
| `pnpm dev` | engine + web together (`concurrently`) |
| `pnpm dev:engine` | `tsx watch apps/engine/src/cli.ts --port 47900` with `JASPER_APPDIR=./.stage JASPER_DEV=1` |
| `pnpm dev:web` | Vite dev server on 5173 with the engine proxy |
| `pnpm dev:desktop` | builds the Electron main/preload and launches it against 5173 (headless: `xvfb-run -a`) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest (all packages and apps as projects); `FUZZ=1 pnpm test` runs the long property sweeps |
| `pnpm lint` | Biome + `scripts/check-tokens.mjs` (no color literals outside theme files, S05:DT-002) |
| `pnpm format` | Biome formatter |
| `pnpm build` | web (`vite build`), engine (`dist/engine.mjs`), desktop (`dist-electron/`) |
| `pnpm mg:build` | builds `native/mg` (stub until WP-2G) |
| `pnpm fixtures` | generates test media with ffmpeg |
| `pnpm e2e` | Playwright smoke (wave 3) |
| `pnpm verify` | lint + typecheck + test + build |

## Layout

```
apps/web          Vite + React 19 SPA (react-router 7 library mode), PWA
apps/engine       Fastify 5 media engine ("jasperd"), port 47900 in dev
apps/desktop      Electron shell (loads the SPA over HTTP)
packages/project  @jasper/project — document schema, commands, invariants, keyframes, render snapshot
packages/session  @jasper/session — EditorSession, history, gestures, transport, persistence
packages/api      @jasper/api — zod contracts for engine routes and events
packages/engine-client, packages/ui, packages/compositions, packages/mg-templates, packages/config
.stage/           dev appdir (runtime files are gitignored)
```

Clean-room rule: never open or copy anything from `.reference/` or `editor-starter.zip` (see ARCHITECTURE §0).

# Orquester multi-platform setup (web + mobile PWA + Electron desktop): analysis and a recipe for JasperEditor

Source analysed: `/var/lib/orquester/workspaces/jaspersito/orquester` (HEAD `0b773dc9`, pnpm 10 monorepo).
All paths below are relative to that repo root unless prefixed with `JasperEditor/`.
Secrets (`.env*`, `.secrets/`, `DEPLOY_TO_VPS.md`, `deploy/targets.conf`, `.stage/daemon/daemon.json` password hash) were deliberately not read or copied.

---

## 0. TL;DR

- **Architecture:** one Node **daemon** (`apps/daemon`, Fastify 4, run with `tsx`, no build step) owns all state and side effects. There are two thin clients, **web/PWA** (`apps/web`) and **Electron** (`apps/desktop`). Both render the same React package, `packages/ui`, via a root component `<OrquesterApp runtime=… transporter=… />`. Shared wire types live in `packages/api`, and appdir paths and zod schemas live in `packages/config`.
- **Transports:** the daemon always listens on a **unix socket** (`<appdir>/daemon/daemon.sock`). This socket is trusted and unauthenticated, and only the desktop uses it. It can also listen on an **opt-in TCP HTTP transport** (`127.0.0.1:47831`), which uses bearer auth and serves the built web SPA from `ORQUESTER_WEB_DIR`. On a VPS, Caddy terminates TLS and reverse-proxies to that port.
- **Web/PWA:** a plain Vite 6 + React 18 SPA. The PWA is **hand-rolled** (no `vite-plugin-pwa`): `public/site.webmanifest`, `public/sw.js`, static PNG icons, and `src/pwa.ts`, which registers the SW only when `import.meta.env.PROD`. Web Push goes through `web-push` (VAPID) on the daemon. Mobile ergonomics come from safe-area CSS, `overscroll-behavior:none` and a `visualViewport`-driven shell height.
- **Desktop:** Electron 33 plus electron-builder 26 (config inline in `apps/desktop/package.json`, targets AppImage/NSIS/DMG). The renderer is a **separate Vite app** (`apps/desktop/index.html` + `src/renderer.tsx`, `base: "./"`). In dev it loads `http://127.0.0.1:5174`; in prod it uses `loadFile(dist/index.html)`. The main process is esbuild-bundled to `dist-electron/main.cjs` and **imports the daemon in-process** (`startDaemon()` from `@orquester/daemon`). The renderer talks to the daemon only through a `contextBridge` IPC bridge that the main process forwards as HTTP-over-unix-socket. There is **no auto-update, no code signing and no publish config**.
- **Things to avoid copying:**
  1. The current desktop bundle is broken. Running `dist-electron/main.cjs` with an Electron stub throws `createRequire(undefined)` at load, because esbuild emits ESM `import.meta.url` into a CJS bundle as `{}`.
  2. The IPC bridge buffers whole response bodies, which cannot work for video.
  3. The packaged app is ~402 MB because every daemon dependency is shipped twice.
  4. `webDir` is resolved to `<repo>/apps/web/dist`, which does not exist in a packaged app.
  5. Tmux, agent, git, MCP and "Design Mode" code is Orquester-specific.
- **Recommendation for JasperEditor:**
  - Copy the monorepo shape, the shared-UI and `runtime` pattern, the Transporter abstraction, the hand-written SW and manifest, the appdir and `.stage` sandbox, and the systemd + Caddy + `deploy.sh` flow.
  - Do **not** copy these three things:
    - in-process esbuild-to-CJS bundling of the daemon;
    - the unix-socket/IPC byte bridge;
    - a separate desktop renderer app.
  - Instead, run the media daemon as a **separate process** (Electron `utilityProcess.fork` or `ELECTRON_RUN_AS_NODE`) on **loopback TCP with a random port and a per-launch token**, and have Electron load the **same React Router SPA build** served by that daemon. `<video>`, Remotion `<Player>`, waveform and thumbnail requests then use plain HTTP with Range support in every runtime.

---

## 1. Repository layout (tracked files relevant to platforms)

```
orquester/
├── package.json                 # root scripts, pnpm onlyBuiltDependencies, packageManager pnpm@10.12.1
├── pnpm-workspace.yaml          # packages: apps/*, packages/*
├── tsconfig.base.json           # shared compilerOptions (Bundler resolution, noEmit, allowImportingTsExtensions)
├── .gitignore                   # dist/, dist-electron/, release/, .env.*, /.secrets/, deploy/targets.conf, .stage runtime files
├── AGENTS.md / CLAUDE.md        # agent rules (CLAUDE.md is a 1-line pointer to AGENTS.md)
├── README.md                    # architecture + scripts table
├── deploy.sh                    # VPS lifecycle CLI (deploy/provision/verify/rollback/logs/rotate-password)
├── DEPLOY_TO_VPS.md.example     # runbook template (real one is gitignored)
├── deploy/
│   ├── Caddyfile                # TLS + CSP + reverse_proxy 127.0.0.1:47831
│   ├── orquester.service        # hardened systemd unit, `node --import tsx apps/daemon/src/cli.ts`
│   ├── daemon.env.example       # ORQUESTER_HTTP_* + ORQUESTER_WEB_DIR
│   ├── targets.conf.example     # ini-style host list for deploy.sh
│   ├── lib/{common.sh,remote-update.sh,remote-provision.sh}
│   ├── provision-devtools.sh, devtools-user.sh, sudoers.d/orquester-pkg   # Orquester-specific
│   └── README.md
├── scripts/
│   ├── fix-node-pty-perms.mjs   # root postinstall (chmod +x node-pty spawn-helper)
│   ├── smoke-web.mjs            # post-deploy puppeteer-core smoke test of the deployed SPA
│   ├── smoke-web-fixtures.json
│   └── test/assert-ok*.mjs      # node:test helpers
├── .stage/                      # committed dev sandbox appdir (app/app.json, app/remotes.json, daemon/daemon.json, workspaces/.gitkeep)
├── apps/
│   ├── daemon/                  # @orquester/daemon — Fastify server; exports "./src/index.ts" (startDaemon)
│   │   ├── package.json, tsconfig.json
│   │   └── src/{cli.ts,index.ts (5k lines),broadcaster.ts,push.ts,…}
│   ├── web/                     # @orquester/web — Vite SPA + PWA
│   │   ├── index.html, vite.config.ts, tailwind.config.ts, postcss.config.cjs, tsconfig.json
│   │   ├── public/{site.webmanifest,sw.js,theme-boot.js,icon-192.png,icon-512.png,apple-touch-icon.png,favicon-{16,32,48}.png}
│   │   └── src/{main.tsx,pwa.ts,styles.css,vite-env.d.ts}
│   └── desktop/                 # @orquester/desktop — Electron
│       ├── package.json         # includes electron-builder "build" block
│       ├── index.html, vite.config.ts (base "./"), tailwind.config.ts, postcss.config.cjs, tsconfig.json
│       ├── scripts/build-main.ts        # esbuild bundle of src/main.ts → dist-electron/main.cjs
│       ├── assets/logo-{32,512}.png     # tray/window icons (copied into dist-electron)
│       ├── build/icon.png               # electron-builder buildResources icon (512x512+)
│       ├── public/theme-boot.js
│       └── src/{main.ts,preload.cjs,renderer.tsx,styles.css,vite-env.d.ts,transport/{unix-socket-transporter.ts,node-http-client.ts}}
└── packages/
    ├── ui/        # @orquester/ui — shared React app (OrquesterApp, zustand store, transporters, theme, hooks, globals.css, tailwind-preset.ts)
    ├── api/       # @orquester/api — pure TS wire contracts + reference client
    ├── config/    # @orquester/config — appdir layout, defaults, zod schemas, env overrides
    └── registry/  # @orquester/registry — static catalog of launchable tools (Orquester-specific)
```

Build outputs (gitignored): `apps/web/dist`, `apps/desktop/dist`, `apps/desktop/dist-electron`, `apps/desktop/release`.
An AppImage from today exists at `apps/desktop/release/Orquester-0.0.0.AppImage`: **402 MB**, with `app.asar` at 219 MB and `app.asar.unpacked` at 550 MB.

---

## 2. Root workspace config

### `package.json` (root)

```json
{
  "name": "orquester",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.12.1",
  "scripts": {
    "dev": "cross-env ORQUESTER_APPDIR=./.stage pnpm --filter @orquester/desktop dev",
    "dev:bare": "pnpm --filter @orquester/desktop dev",
    "dev:daemon": "cross-env ORQUESTER_APPDIR=./.stage tsx watch apps/daemon/src/cli.ts",
    "dev:daemon:bare": "tsx watch apps/daemon/src/cli.ts",
    "dev:web": "cross-env VITE_ORQUESTER_API_URL=http://127.0.0.1:47831 pnpm --filter @orquester/web dev",
    "dev:desktop": "pnpm --filter @orquester/desktop dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "check": "pnpm -r typecheck",
    "postinstall": "node scripts/fix-node-pty-perms.mjs",
    "test": "pnpm -r --if-present test"
  },
  "devDependencies": { "cross-env": "^7.0.3", "tsx": "^4.20.3", "typescript": "^5.8.3" },
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3", "electron", "esbuild", "node-pty"],
    "peerDependencyRules": { "allowedVersions": { "@anthropic-ai/claude-agent-sdk>zod": "3" } }
  }
}
```

Points to note:
- `pnpm.onlyBuiltDependencies` is pnpm 10's allow-list for install scripts. Without `electron` in it, the Electron binary is never downloaded. Without the native modules in it, they are never built.
- There is no `.npmrc`, so pnpm uses its default isolated `node_modules/.pnpm` layout. electron-builder 26 coped with that: its node-module collector walks pnpm's layout, and the AppImage built.
- `.stage` sandbox: every dev script sets `ORQUESTER_APPDIR=./.stage` so dev never touches `~/.orquester`. Copy this pattern as `JASPER_APPDIR=./.stage`.

### `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022", "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false, "skipLibCheck": true, "esModuleInterop": true,
    "allowSyntheticDefaultImports": true, "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext", "moduleResolution": "Bundler", "resolveJsonModule": true,
    "isolatedModules": true, "jsx": "react-jsx",
    "noEmit": true, "allowImportingTsExtensions": true
  }
}
```

Each package's `tsconfig.json` is just `{"extends": "../../tsconfig.base.json", "include": ["src"]}`, plus `"types": ["node"]` for Node packages.
`noEmit: true` everywhere means **no package is ever compiled to JS**. Each package's `package.json` `exports` points at `./src/index.ts`, and consumers (Vite, tsx, esbuild) transpile the source directly:

```json
// packages/ui/package.json (same shape for api/config/registry/daemon)
{ "name": "@orquester/ui", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json" },
  "peerDependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" } }
```

Dependencies are wired with `"@orquester/ui": "workspace:*"`. This source-sharing pattern is worth copying: there is no build ordering and HMR works across packages.

### Resolved versions (from `pnpm-lock.yaml`)

| Tool | Orquester | JasperEditor today | Note |
|---|---|---|---|
| electron | 33.4.11 | – | Chromium 130 / Node 20.18. Pick current stable for JasperEditor (needs good WebCodecs). |
| electron-builder | 26.15.3 (+ @electron/rebuild 4.0.4) | – | |
| esbuild | 0.25.12 | – | main-process bundler |
| vite | 6.4.3 | 7.3.6 | |
| react | 18.3.1 | 19.2.x | |
| tailwindcss | 3.4.19 (PostCSS + preset) | 4.3.x (`@tailwindcss/vite`) | Sharing differs, see §8.4. |
| fastify | 4.29.1 (+ @fastify/static 7, @fastify/websocket 10) | – | |
| typescript | 5.9.3 | 5.9.3 | |
| tsx | 4.22.4 | – | runs the daemon in dev *and* prod |
| concurrently / wait-on / cross-env | 9.2.1 / 8.0.5 / 7.0.3 | – | desktop dev orchestration |

---

## 3. `apps/web`: web SPA plus installable PWA

### 3.1 Package and Vite config

`apps/web/package.json`:
- scripts:
  - `dev`: `vite --host 127.0.0.1 --port 5173`
  - `build`: `vite build`
  - `preview`: port 4173
  - `typecheck`: `tsc -p tsconfig.json`
- deps: `@orquester/api`, `@orquester/ui`, `@vitejs/plugin-react ^4.5.2`, `react/react-dom ^18.3.1`, `tailwindcss ^3.4.17`, `postcss`, `autoprefixer`, `vite ^6.3.5`
- devDeps: `vite-plugin-svgr ^5.2.0`, types

`apps/web/vite.config.ts` (the whole file):

```ts
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), svgr({ svgrOptions: { icon: true, svgProps: { width: "1em", height: "1em" } } })]
});
```

The config has **no PWA plugin, no `server.proxy` and no `base`**. The SPA is served at `/` by the daemon's `@fastify/static` in production.

Dev caveat: `pnpm dev:web` points the SPA at `VITE_ORQUESTER_API_URL=http://127.0.0.1:47831`. That is a cross-origin call from `:5173`, and the daemon registers **no CORS** (there is no `@fastify/cors`; grep finds none). Bearer-auth requests therefore need a preflight that the daemon will not answer. For JasperEditor, use a Vite `server.proxy` instead (see §8.3).

### 3.2 Entry: `apps/web/src/main.tsx`

```tsx
import { OrquesterApp, createLocalStorageAppConfigAdapter } from "@orquester/ui";
import { registerServiceWorker } from "./pwa";
import "./styles.css";

registerServiceWorker();
// same-origin when served by the daemon; standalone dev uses VITE_ORQUESTER_API_URL
const endpoint = import.meta.env.VITE_ORQUESTER_API_URL ?? window.location.origin;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OrquesterApp
      runtime="web"
      appConfigAdapter={createLocalStorageAppConfigAdapter()}   // web stores UI prefs in localStorage
      initialConnection={{ id: "remote", name: "Remote server", kind: "remote", endpoint, status: "disconnected" }}
    />
  </React.StrictMode>
);
```

The file also handles a deep link (`?workflow=…&run=…`) that the SW opens from a push-notification click.

Routing: there is **no router**. The app is a single screen driven by zustand state (tabs/panels). Deep links are parsed by hand from `location.search` and stripped with `history.replaceState`. JasperEditor uses React Router 7, so its routing differs (see §8.2).

### 3.3 `index.html` (the PWA-relevant head)

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
<link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
<link rel="manifest" href="/site.webmanifest" />
<meta name="theme-color" content="#111111" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Orquester" />
<!-- external (not inline) because prod CSP is script-src 'self' -->
<script src="/theme-boot.js"></script>
```

`public/theme-boot.js` is a blocking classic script. It reads `localStorage["orquester:theme"]` and stamps `data-scheme`/`data-mode`/`color-scheme` on `<html>` before the bundle loads, which prevents a flash of the wrong theme. A byte-identical copy lives in `apps/desktop/public/`.

### 3.4 Manifest: `public/site.webmanifest`

```json
{
  "name": "Orquester", "short_name": "Orquester",
  "description": "…",
  "id": "/", "start_url": "/", "scope": "/",
  "display": "standalone",
  "theme_color": "#111111", "background_color": "#111111",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

Icons are static, hand-made RGBA PNGs: 16/32/48 favicons, 180 apple-touch, 192 and 512. There is no icon generator. The same PNG is reused as `maskable`, so a logo without safe-zone padding gets cropped on Android. For JasperEditor, make a separate padded maskable PNG.

### 3.5 Service worker: `public/sw.js`, hand-written and copied verbatim to `dist/`

The strategy (≈230 lines, `VERSION = "v6"`; bump it to invalidate caches):
- `install`: precache `["/index.html", "/theme-boot.js"]`. It deliberately does **not** use `cache.addAll`, which is atomic and fails wholesale on one missing file. Then `skipWaiting()`.
- `activate`: delete caches not in `[orq-shell-v6, orq-assets-v6]`, then `clients.claim()`.
- `fetch`:
  - Only same-origin `GET`s are handled.
  - **Bypass list** (never `respondWith`): `["/api", "/events", "/ws", "/health", "/mcp", "/devtools-frontend", "/ws-devtools"]`.
  - navigations: network-first; each success is cached under the key `/index.html`, and offline falls back to that cached shell.
  - `/assets/*` (content-hashed): cache-first, trimmed to 60 entries.
  - other root statics (icons, manifest): network-first with a cache fallback.
  - Every miss returns `Response.error()` rather than `undefined`. Returning `undefined` fails with "Failed to convert value to 'Response'".
- `push`: `showNotification(payload.title, {body, tag, icon:"/icon-192.png", data})`.
- `notificationclick`: if a window exists, focus it and `postMessage({type:"orquester:open-workflow-run",…})`; otherwise `clients.openWindow("/?workflow=…&run=…")`.

Registration lives in `apps/web/src/pwa.ts`, which only the web host imports:

```ts
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;   // never in dev
  navigator.serviceWorker.addEventListener("message", (e) => { /* deep link from notificationclick */ });
  navigator.serviceWorker.startMessages?.();
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});        // failure degrades to plain web app
  });
}
```

### 3.6 Web Push (VAPID)

- Daemon, `apps/daemon/src/push.ts`: uses `web-push`. It lazily generates a VAPID keypair and stores it with subscriptions in `<appdir>/daemon/push.json` (mode 0600). Routes are `GET /api/push/info` (public key), `POST /api/push/subscriptions` and `POST /api/push/test`.
- UI, `packages/ui/src/lib/push.ts`:
  - `pushSupported()` checks for `serviceWorker`, `PushManager` and `Notification`.
  - `enablePush(api)` runs `Notification.requestPermission`, then `pushManager.subscribe({applicationServerKey})`, then POSTs the subscription to the daemon.
  - The UI shows this only when `runtime === "web" && pushSupported()`.
- iOS only allows push for an **installed** PWA. That is one reason the standalone manifest matters.

### 3.7 Mobile ergonomics (`apps/web/src/styles.css` + `packages/ui` hooks)

```css
html, body { overscroll-behavior: none; }          /* kill pull-to-refresh reloading the SPA */
#root > * {                                        /* app shell owns safe-area insets */
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
  box-sizing: border-box;
}
```

- `packages/ui/src/hooks/use-viewport-height.ts` sizes the shell to `visualViewport.height`, rAF-coalesced and listening to visualViewport `resize` and `scroll` plus `orientationchange`, so the layout fits above the soft keyboard.
- `use-soft-keyboard-open.ts` and `use-media-query.ts` handle the rest.
- `position: fixed` overlays pad their own bottom inset.
- These rules sit in the web-only stylesheet. The desktop stylesheet omits them.

---

## 4. `apps/desktop`: Electron

### 4.1 `apps/desktop/package.json` (scripts, deps, electron-builder)

```json
{
  "name": "@orquester/desktop",
  "type": "module",
  "main": "dist-electron/main.cjs",
  "scripts": {
    "dev": "concurrently -k \"vite --host 127.0.0.1 --port 5174\" \"pnpm build:main --watch\" \"wait-on http://127.0.0.1:5174 dist-electron/main.cjs && cross-env ORQUESTER_DESKTOP_DEV_URL=http://127.0.0.1:5174 electron .\"",
    "build:main": "tsx scripts/build-main.ts",
    "build:ui": "vite build",
    "build:electron": "electron-builder",
    "build": "pnpm build:main && pnpm build:ui && pnpm build:electron",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@orquester/daemon": "workspace:*", "@orquester/ui": "workspace:*",
    "better-sqlite3": "^12.0.0", "node-pty": "^1.1.0", "ws": "^8.21.0",
    "react": "^18.3.1", "react-dom": "^18.3.1", "vite": "^6.3.5", "tailwindcss": "^3.4.17", "…": "…"
  },
  "devDependencies": {
    "electron": "^33.4.11", "electron-builder": "^26.15.3", "esbuild": "^0.25.12",
    "concurrently": "^9.2.0", "wait-on": "^8.0.3", "cross-env": "^7.0.3", "…": "…"
  },
  "build": {
    "appId": "com.orquester.desktop",
    "productName": "Orquester",
    "directories": { "output": "release" },
    "files": ["dist/**/*", "dist-electron/**/*"],
    "mac":   { "target": "dmg", "executableName": "orquester" },
    "win":   { "target": [{ "target": "nsis", "arch": ["x64"] }], "executableName": "orquester" },
    "linux": { "target": ["AppImage"], "executableName": "orquester", "category": "Utility" }
  }
}
```

Dev flow: three concurrent processes.
1. The renderer Vite dev server runs on `:5174`.
2. esbuild watches the main process.
3. `wait-on` waits for both, then starts `electron .` with `ORQUESTER_DESKTOP_DEV_URL` set.

Main-process changes need a manual Electron restart; the script does not restart it.

Packaging:
- `electron-builder` reads the inline `build` block. `buildResources` defaults to `build/`, which contains `build/icon.png` (a single 512+ PNG from which all platform icons are derived).
- electron-builder also packs **every production `dependency`**. Here that means the whole daemon dependency tree, even though esbuild already bundled it into `main.cjs`, and even `vite`/`react`/`tailwindcss`, which are only build-time.
- Native modules are rebuilt for the Electron ABI automatically (`npmRebuild` defaults to true, via `@electron/rebuild`) and smart-unpacked into `app.asar.unpacked/node_modules/{node-pty,better-sqlite3,…}`.
- Result: a 402 MB AppImage.

Missing from the build: no `publish`, no `electron-updater`, no signing or notarization config, no `asarUnpack`, no `extraResources`, no `protocols`/file associations, no `afterPack` hooks.

### 4.2 Main-process bundling: `apps/desktop/scripts/build-main.ts`

```ts
const options: BuildOptions = {
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(root, "dist-electron", "main.cjs"),
  bundle: true, platform: "node", target: "node20", format: "cjs", sourcemap: true,
  external: ["electron", "node-pty", "better-sqlite3"],
  plugins: [{ name: "copy-assets", setup(build) { build.onEnd(async () => {
    // copy src/preload.cjs and assets/logo-{32,512}.png into dist-electron/
  }); } }]
};
if (watch) { await rm(outfile, { force: true }); (await context(options)).watch(); } else { await build(options); }
```

> **BUG, do not replicate.** The daemon and its dependencies are ESM and use `import.meta.url` (e.g. `apps/daemon/src/agent-chat/supervisor.ts:30`, `agent-host/index/sqlite.ts:90`, plus a minified third-party dependency). esbuild's `format: "cjs"` replaces `import.meta` with `{}`. I loaded the current `dist-electron/main.cjs` (built 2026-09-29 04:12) under Node with an `electron` stub, and it throws at module-evaluation time:
> `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be … Received undefined at createRequire (main.cjs:185879)`
> The packaged app therefore cannot start the daemon. The daemon also launches child processes from **source files** (`new URL("../agent-host/main.ts", import.meta.url)` run via `tsx`), and those files are not in the asar.
> Lesson: bundle the main process as **ESM** (`format: "esm"`, `main.mjs`; Electron ≥ 28 supports an ESM main), and/or run the daemon as its **own process** from its own bundle. Never inline a server with child-process entry points into the Electron main bundle.

### 4.3 Main process: `apps/desktop/src/main.ts` (719 lines)

Startup, in `app.whenReady()`:
1. `ensureAppFiles()` creates `<base>/app/{app.json,remotes.json,logs/}`. `app.json` defaults to `{version:1, activeConnectionId:"local", useTitlebar:true, runInBackground:false}`. `remotes.json` is seeded from `ORQUESTER_REMOTE_URL`.
2. The base dir is `ORQUESTER_APPDIR` (relative paths resolve against the repo root) or `~/.orquester`. It does **not** use `app.getPath("userData")`.
3. `checkExistingDaemon(socketPath)` sends `GET /api/config/daemon` over the socket. If a daemon already runs (e.g. systemd or another instance), it attaches to it with `isDaemonOwner=false`.
4. Otherwise it unlinks the stale socket and calls `startIntegratedDaemon()`:

   ```ts
   const webDir = path.join(repoRoot, "apps", "web", "dist");     // BUG in packaged builds (asar path)
   daemon = await startOrquesterDaemon({
     cwd: repoRoot,
     env: { ...process.env, ORQUESTER_UNIX_SOCKET: socketPath, ORQUESTER_WEB_DIR: webDir,
            ...(process.env.ORQUESTER_HTTP_ENABLED ? {} : { ORQUESTER_HTTP_ENABLED: "false" }) },
     appdir: process.env.ORQUESTER_APPDIR ? baseDir() : undefined,
     webDir
   });
   ```

   The daemon runs **inside the Electron main process**, so a heavy CPU task or a crash takes the UI's main process with it.
5. `listenForDaemonShutdown()` holds a `GET /events` NDJSON stream open. On a `daemon.shutdown` event it quits the app. If an attached (non-owned) daemon's stream ends, it also quits.
6. `registerIpc()`, then `createTray()` (only when it owns the daemon), then `createWindow()`.

Window:

```ts
new BrowserWindow({
  width: 1320, height: 860, minWidth: 1040, minHeight: 680,
  frame: false, titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 12 },
  show: false, backgroundColor: readWindowTheme().background,          // persisted from renderer → no flash
  icon: nativeImage.createFromPath(logoPath("logo-512.png")),
  webPreferences: { contextIsolation: true, nodeIntegration: false,
                    preload: path.join(desktopRoot, "dist-electron", "preload.cjs") }
});
// dev vs prod:
devUrl ? mainWindow.loadURL(devUrl) : mainWindow.loadFile(path.join(desktopRoot, "dist", "index.html"));
```

- The window is frameless. The UI draws its own titlebar using `.app-drag` / `.app-no-drag` utilities (`-webkit-app-region`) from `packages/ui/src/styles/globals.css`, and calls `windowControls.{minimize,toggleMaximize,close}` over IPC.
- Window background: the renderer reports its theme colour through `setWindowBackground`. The main process validates it (hex regex, and mode ∈ light/dark) and persists it to `<base>/app/window-theme.json` so the next launch paints the correct colour.
- Tray, run-in-background and quit:
  - The tray menu has "Open", an "HTTP transport On/Off" toggle (`PUT /api/config/daemon`) and "Quit", which sends `POST /api/daemon/shutdown` and then calls `stopIntegratedDaemon()`.
  - When `app.json.runInBackground` is true, closing the window hides it instead.
  - `before-quit` awaits `daemon.stop()`.
- The main process has **no security hardening** beyond `contextIsolation`: `sandbox` is not set, and there is no `setWindowOpenHandler`, no `will-navigate` guard and no CSP for `file://`.

### 4.4 Preload and IPC bridge: `apps/desktop/src/preload.cjs`

The preload is a plain CJS file (copied, not bundled). It exposes `window.orquesterDesktop`:

| Bridge member | IPC channel | Main-process handler |
|---|---|---|
| `request(req)` | `invoke orquester:request` | `http.request({socketPath})`; the **full body is buffered** and returned as a utf8 string |
| `requestBytes(req)` | `invoke orquester:request-bytes` | same, returned as an ArrayBuffer (file preview) |
| `requestAbort(id)` | `send orquester:request:abort` | destroys the ClientRequest (checks `senderId`) |
| `streamOpen(id,path)` / `streamClose(id)` / `onStreamData` / `onStreamEnd` | `orquester:stream:*` | chunked GET over the socket; chunks are forwarded as utf8 strings |
| `httpRequest` / `httpRequestBytes` / `httpRequestAbort` / `httpStream*` | `orquester:http*` | the same over TCP to **remote** daemons, performed in Node to avoid CORS |
| `setWindowBackground(p)` | `send orquester:window-background` | validated, persisted, `setBackgroundColor` |
| `windowControls.*` | `send orquester:window` | minimize / toggleMaximize / close |
| `runtime`, `dataDir`, `socketPath`, `defaultConnection` | – | static values from env |

Renderer adapters (`apps/desktop/src/transport/`):
- `UnixSocketTransporter implements Transporter`: JSON goes over IPC, uploads are materialised to an ArrayBuffer (a 2× memory cost), and streams are mapped by `streamId`.
- `NodeHttpClient implements HttpClient`: remote HTTP routed through the main process.

`apps/desktop/src/renderer.tsx` mounts `<OrquesterApp runtime="desktop" useTitlebar transporter={new UnixSocketTransporter(bridge)} httpClient={new NodeHttpClient(bridge)} windowControls={bridge.windowControls} initialConnection={bridge.defaultConnection} />` and declares `window.orquesterDesktop` globally.

Why this is unsuitable for a video editor:
- Every response is buffered into memory (`Buffer.concat(chunks)`) and structured-cloned across IPC.
- `<video src>`, `<audio>`, `<img>`, Remotion `<Player>`, `@remotion/media` and mediabunny all need **real URLs with HTTP Range support**. An IPC bridge cannot give them that.
- JasperEditor needs a loopback HTTP origin, or a custom protocol that streams (`protocol.handle` returning a `Response` with a stream body).

### 4.5 Desktop renderer build

`apps/desktop/vite.config.ts` is identical to the web one plus `base: "./"`, which gives relative asset URLs so `loadFile` works under `file://`. `index.html` has no manifest and no SW. It is a **second copy of the web entry** with a different transport. That works because Orquester has no router. With React Router 7, `file://` plus `BrowserRouter` paths do not work, so JasperEditor should not keep a second renderer app (see §8.5).

### 4.6 Auto-update, signing, native modules

- **Auto-update:** none. There is no `electron-updater` dependency and no `publish` config.
- **Signing:** none. The mac DMG and Windows NSIS builds would be unsigned.
- **Native modules:**
  - `node-pty` and `better-sqlite3` are `external` in esbuild, listed in `dependencies` and in `pnpm.onlyBuiltDependencies`, and rebuilt for Electron by electron-builder.
  - `scripts/fix-node-pty-perms.mjs` (root `postinstall`) restores the exec bit on `node-pty/prebuilds/*/spawn-helper` in both the pnpm and hoisted layouts.
  - In the packaged app, `app.asar.unpacked` also contains `esbuild`, `@rollup/*`, `@napi-rs/canvas-*` and `@anthropic-ai/*`. These are accidental: they are pulled in via `dependencies`.

---

## 5. `apps/daemon`: the local and remote server

### 5.1 What it is

- It is `@orquester/daemon`, with `exports: {".": "./src/index.ts"}` and **no build**: `build` and `typecheck` are both `tsc` with noEmit.
- Dev: `tsx watch src/cli.ts`. Prod (systemd): `node --import tsx apps/daemon/src/cli.ts --appdir /var/lib/orquester`.
- `cli.ts` parses `--appdir` (`parseAppdir`), calls `startDaemon({appdir, cwd, env})`, and on SIGINT/SIGTERM calls `daemon.stop()` with a 3 s forced exit.
- `index.ts` exports:
  - `startDaemon(options: StartDaemonOptions): Promise<RunningDaemon>`, where options are `{cwd, appdir, env, homeDir, platform, webDir}` and the result is `{daemonId, socketPath, workspacesDir, stop()}`;
  - `createServer(config, resolved, clientConfig, logStream, services, {authRequired, mode:"local"|"remote", serveWeb})`.

### 5.2 Transports (the key design)

```ts
// always: trusted local unix socket, no auth
const unixServer = createServer(config, resolved, clientConfig, logStream, services, { authRequired: false, mode: "local" });
await unixServer.listen({ path: paths.socketPath });            // <appdir>/daemon/daemon.sock (win: \\.\pipe\orquester-daemon)

// opt-in, hot-reloadable: remote HTTP with bearer auth (+ optional static SPA)
const app = createServer(config, resolved, clientConfig, logStream, services, { authRequired: true, mode: "remote", serveWeb });
await app.listen({ host: config.transports.http.host, port: config.transports.http.port });   // 127.0.0.1:47831
services.reloadHttp = async () => { await stopHttp(); await startHttp(); };                     // on PUT /api/config/daemon
```

- The same route set is registered on both Fastify instances. Some routes are **transport-asymmetric**: config writes and shutdown work only on the socket; `/mcp` and the DevTools proxy only on HTTP.
- Auth (`onRequest` hook):
  - Only `/api`, `/events` and `/mcp` are gated; `/api/auth/info` is public.
  - The client fetches the bcrypt salt from `/api/auth/info` and derives the bcrypt hash locally. The bearer is `base64("<user>:<hash>")`, so the plain password never crosses the wire.
  - Failures get a per-IP escalating throttle and return 429. `trustProxy: "127.0.0.1"` is set only in remote mode, for Caddy.
  - `?token=` is accepted only for `/api/fs/download` and `/ws`, and is redacted from logs.
- Realtime:
  - `GET /events` is an **NDJSON** stream (`content-type: application/x-ndjson`, `x-accel-buffering: no`). The `Broadcaster` (`apps/daemon/src/broadcaster.ts`) fans out `EventMessage {id, channel, type, createdAt, payload}` to every sink, with a 15 s `daemon.heartbeat`.
  - `/ws` is a multiplexed WebSocket for terminal I/O (`@fastify/websocket`, registered once at the root). It avoids the browser's 6-connections-per-origin limit.
- Static SPA:

  ```ts
  if (options.serveWeb) {
    void app.register(fastifyStatic, { root: options.serveWeb, wildcard: true });  // wildcard:true → new hashed assets after rebuild served w/o restart
    app.setNotFoundHandler((request, reply) => {
      const isApi = ["/api","/health","/events","/mcp","/devtools-frontend","/ws-devtools"].some(p => request.url.startsWith(p));
      if (request.method !== "GET" || isApi) return reply.code(404).send({ code: "NOT_FOUND", message: "Route not found." });
      return reply.sendFile("index.html");                                        // SPA fallback
    });
  }
  ```

- `GET /health` returns `{ok:true}` (public). Deploys, systemd and the desktop use it.

### 5.3 Config and appdir (`packages/config/src/index.ts`)

- The base dir is `--appdir`, else `ORQUESTER_APPDIR`, else `~/.orquester` (`ORQUESTER_DIR_NAME`). Path strings may use the variables `$userhome`, `$user`, `$cwd` and `$appdir`.
- Layout:
  - `<appdir>/app/{app.json,remotes.json,logs/}` holds client and desktop prefs.
  - `<appdir>/daemon/{daemon.json,daemon.sock,push.json,…,logs/YYYY-MM-DD.log}` holds daemon state.
- Env overrides: `ORQUESTER_DAEMON_CONFIG`, `ORQUESTER_UNIX_SOCKET`, `ORQUESTER_HTTP_ENABLED`, `ORQUESTER_HTTP_HOST`, `ORQUESTER_HTTP_PORT` (default `DEFAULT_HTTP_PORT = 47831`), `ORQUESTER_HTTP_USERNAME`, `ORQUESTER_HTTP_PASSWORD` and `ORQUESTER_WEB_DIR`.
- Every persisted file has a zod schema, with tolerant parsing of unknown fields.

### 5.4 How desktop bundles the daemon

It **does not spawn** the daemon. It imports `startDaemon` and esbuild inlines the whole daemon into `main.cjs` (12 MB plus a 21 MB sourcemap). As shown in §4.2, that is currently broken. The attach-to-existing-daemon logic (`checkExistingDaemon`) is good and worth keeping. It lets the desktop app act as a client of an already-running system daemon.

---

## 6. `packages/*`: what is shared and how

| Package | Content | Consumers | Worth copying? |
|---|---|---|---|
| `packages/ui` | The entire React app: `OrquesterApp.tsx` (root), `context/orquester-context.tsx` (`runtime`, `api`, `windowControls`), `store/app.ts` (zustand), `lib/transporter.ts` (the `Transporter` interface), `lib/transporters/{http-transporter,ws-session-channel,ws-browser-channel}.ts`, `lib/http-client.ts` (`FetchHttpClient`), `lib/api-client.ts` (`ApiClient`), `lib/app-config.ts` (`createLocalStorageAppConfigAdapter`), `lib/theme.ts`, `lib/push.ts`, hooks, `styles/globals.css` (imported from `src/index.ts`), `tailwind-preset.ts` (CSS-variable-driven `neutral` scale for themes) | web, desktop | **Yes (pattern):** one UI package plus a host-injected `runtime`, transporter and window controls |
| `packages/api` | Pure TS wire contracts (request/response types, `EventMessage`, route path constants such as `agentChatRoutes`) | daemon, ui | **Yes:** contracts first, shared by server and client |
| `packages/config` | Appdir path helpers, defaults, zod schemas, env overrides | daemon, ui, api | **Yes** |
| `packages/registry` | Catalog of shells/agents/IDEs/browsers | daemon, ui | No (Orquester-specific). A JasperEditor analog would be an effects/transitions/codec-preset catalog. |

The `Transporter` interface (`packages/ui/src/lib/transporter.ts`) is the core abstraction:

```ts
export interface Transporter {
  readonly kind: string;                                    // "unix" | "http"
  request<T>(req: TransportRequest): Promise<TransportResponse<T>>;
  requestBytes?(req: TransportRequest): Promise<TransportResponse<ArrayBuffer>>;
  openStream(path: string, handlers: StreamHandlers): StreamHandle;     // NDJSON/chunked GET
  sessionChannel?(): SessionChannel;                                     // multiplexed WS (web only)
}
export interface TransportRequest {
  method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"; path: string;
  query?: Record<string, string|number|boolean|undefined>;
  body?: unknown; binaryBody?: Blob|ArrayBuffer|Uint8Array;           // uploads stream as octet-stream
  onUploadProgress?: (sent: number, total: number) => void;           // XHR-based on web
  headers?: Record<string,string>; signal?: AbortSignal;
}
```

`HttpTransporter({baseUrl, credential, httpClient})` handles the web and remote cases. `ApiClient` wraps a transporter, and components never see transport details.

Tailwind sharing (TW3): each app's `tailwind.config.ts` uses `presets: [orquesterPreset]` and `content: ["./index.html","./src/**/*.{ts,tsx}","../../packages/ui/src/**/*.{ts,tsx}"]`.

---

## 7. Deployment: `deploy.sh`, `deploy/`, `DEPLOY_TO_VPS.md.example`, `scripts/`

- **Topology:**
  - The code lives in `/opt/orquester` (a git checkout, owned by root and read-only to the service). The appdir and state live in `/var/lib/orquester`, owned by the system user `orquester`.
  - systemd runs `/usr/bin/node --import tsx /opt/orquester/apps/daemon/src/cli.ts --appdir /var/lib/orquester` with `EnvironmentFile=/etc/orquester/daemon.env` (mode 600).
  - Caddy serves `:443`, reverse-proxies to `127.0.0.1:47831`, and handles WebSocket upgrades automatically.
  - `ufw` allows only 22 and 443.
- **`daemon.env.example`:** `ORQUESTER_HTTP_ENABLED=true`, `ORQUESTER_HTTP_HOST=127.0.0.1`, `ORQUESTER_HTTP_PORT=47831`, `ORQUESTER_HTTP_PASSWORD=<openssl rand -base64 32>`, `ORQUESTER_HTTP_USERNAME=…`, `ORQUESTER_WEB_DIR=/opt/orquester/apps/web/dist`, `HOME=/var/lib/orquester`. systemd's EnvironmentFile does not support inline `#` comments, so keep each comment on its own line.
- **`orquester.service` notes:**
  - `Environment=TMPDIR=/var/lib/orquester/tmp`, because tsx needs a writable transpile cache under `ProtectSystem=strict`.
  - `Restart=always`, `KillMode=process` (keeps tmux alive, which is Orquester-specific), `ProtectSystem=strict`, `ReadWritePaths=…` and `ProtectHome=true`.
  - The `NoNewPrivileges=false` and wide `ReadWritePaths` exist only for Orquester's scoped `sudo apt`. Do not copy them. JasperEditor should use `NoNewPrivileges=true` with `ReadWritePaths=/var/lib/jasper`.
- **Caddyfile:** HSTS, `X-Frame-Options DENY`, `Referrer-Policy no-referrer`, and a strict CSP:
  `default-src 'self'; connect-src 'self' wss:; img-src 'self' data: blob: …; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; manifest-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; …`
  Because `script-src 'self'` forbids inline scripts, `theme-boot.js` is a separate file.
- **`deploy.sh`** (bash, `set -Eeuo pipefail`, hosts in the gitignored `deploy/targets.conf`, ini-style `[name] host/user/sudo/key/domain/repo/branch/ssh_opts`):
  - `deploy [target|all]`: runs `preflight_pushed`, which refuses a dirty tree or unpushed HEAD. It then scp's `deploy/lib/remote-update.sh` and runs it on the host, followed by a smoke test.
  - `remote-update.sh`:
    1. `git fetch && git reset --hard origin/<branch>`
    2. `CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile </dev/null`
    3. `pnpm --filter @orquester/web build`
    4. `chown -R root:root /opt/orquester`
    5. warn if `deploy/Caddyfile` drifted
    6. `systemctl restart orquester`
    7. `curl --retry 25 http://127.0.0.1:47831/health`, then print the live bundle hash
  - `provision <target>` (`remote-provision.sh`, idempotent): creates the service user, installs apt deps, Node 20 via nodesource, pnpm and Caddy, clones the repo, generates the password (shown once), installs systemd and Caddy config, and enables ufw.
  - Other commands: `verify`, `rollback <target> <sha>`, `logs <target> [-n N]`, `rotate-password`, and a `--dry-run` flag.
  - `scripts/smoke-web.mjs` uses `puppeteer-core` (resolved via `createRequire` from `apps/daemon/package.json`) and a system Chrome. It loads the deployed SPA with clean storage and with legacy localStorage fixtures, and fails on page errors or `console.error`.
  - `ELECTRON_SKIP_BINARY_DOWNLOAD=1` matters: the server install must not download Electron.

---

## 8. Recipe: the same architecture for JasperEditor

The current JasperEditor is a single npm package using React Router 7 framework mode with `ssr: true` and the Vercel preset. Its `src/routes.ts` includes server resource routes `api/{upload,progress,render,captions,fonts/:name}`, which call S3, Remotion Lambda and OpenAI. The UI lives in `src/editor/**`, and Remotion compositions live in `src/remotion/**`.

### 8.1 Target layout (pnpm)

```
JasperEditor/
├── package.json                 # packageManager pnpm@10.x, root scripts (below), pnpm.onlyBuiltDependencies
├── pnpm-workspace.yaml          # apps/*, packages/*
├── tsconfig.base.json           # copy Orquester's (+ "verbatimModuleSyntax": false, React 19 JSX)
├── .stage/                      # committed dev appdir: app/, daemon/daemon.json, media/.gitkeep
├── apps/
│   ├── web/                     # React Router 7 SPA (ssr:false) + PWA — moved from repo root src/
│   │   ├── react-router.config.ts, vite.config.ts, public/{manifest.webmanifest,sw.js,icons…}
│   │   └── app/{root.tsx,routes.ts,routes/*,entry.client.tsx(optional)}
│   ├── desktop/                 # Electron shell ONLY (no renderer app)
│   │   ├── package.json (electron-builder block), electron-builder.yml (optional)
│   │   ├── scripts/build-main.ts (esbuild → dist-electron/main.mjs + preload.cjs)
│   │   ├── build/{icon.png,icon.icns,icon.ico,entitlements.mac.plist}
│   │   └── src/{main.ts,preload.cts,daemon-process.ts}
│   └── daemon/                  # "jasperd": Fastify media server (ffmpeg, fframes, Remotion renders)
│       ├── src/{cli.ts,index.ts (startDaemon),routes/*,jobs/*,media/*}
│       └── scripts/build.ts     # esbuild → dist/daemon.mjs (ESM, externals: @remotion/renderer, @remotion/compositor-*, sharp…)
├── packages/
│   ├── editor-ui/               # was src/editor/** — the Premiere-style UI; host injects runtime + transport
│   ├── compositions/            # was src/remotion/** — shared by Player (browser) and renderer (daemon)
│   ├── api/                     # zod contracts: projects, assets, jobs, events (EventMessage), route constants
│   └── config/                  # appdir layout (~/.jasper or userData), defaults, env (JASPER_*)
├── native/fframes-renderer/     # Rust crate (cargo) → binary shipped via extraResources
├── deploy/ + deploy.sh          # copy Orquester's, rename service/user/paths
└── scripts/smoke-web.mjs
```

Root scripts (mirroring Orquester):

```json
{
  "scripts": {
    "dev": "cross-env JASPER_APPDIR=./.stage pnpm --filter @jasper/desktop dev",
    "dev:daemon": "cross-env JASPER_APPDIR=./.stage tsx watch apps/daemon/src/cli.ts",
    "dev:web": "pnpm --filter @jasper/web dev",
    "build": "pnpm -r build",
    "check": "pnpm -r typecheck",
    "test": "pnpm -r --if-present test"
  },
  "pnpm": { "onlyBuiltDependencies": ["electron", "esbuild", "@swc/core", "sharp"] }
}
```

Adjust `onlyBuiltDependencies` to whatever needs install scripts. Remotion's `@remotion/compositor-*` packages ship prebuilt binaries in optionalDependencies and need none.

### 8.2 `apps/web`: React Router 7 in SPA mode

Server resource routes cannot be used with `ssr:false`: non-prerendered server loaders and actions are not allowed. Move every `src/routes/api/*.ts` handler into the daemon (§8.6) and make the web app pure static.

```ts
// apps/web/react-router.config.ts
import type { Config } from "@react-router/dev/config";
export default {
  appDirectory: "app",
  ssr: false,                 // SPA mode → build/client/index.html + hashed assets
  // prerender: ["/"],        // optional
  // drop vercelPreset() — not deploying to Vercel
} satisfies Config;
```

```ts
// apps/web/vite.config.ts
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const DAEMON = process.env.JASPER_DAEMON_URL ?? "http://127.0.0.1:47900";
export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  server: {
    host: "127.0.0.1", port: 5173,
    // same-origin in dev: avoids the CORS gap Orquester's dev:web has
    proxy: {
      "/api":    { target: DAEMON, changeOrigin: false },
      "/events": { target: DAEMON },                 // NDJSON stream (proxy passes chunked through)
      "/media":  { target: DAEMON },                 // Range requests for <video>/<Player>
      "/ws":     { target: DAEMON.replace("http", "ws"), ws: true },
      "/health": { target: DAEMON }
    }
  },
  optimizeDeps: { /* keep the existing Remotion excludes */ }
});
```

Root and entry (runtime detection):

```tsx
// apps/web/app/root.tsx (excerpt)
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#1d1d1d" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <script src="/theme-boot.js" />{/* external, CSP script-src 'self' */}
        <Meta /><Links />
      </head>
      <body>{children}<ScrollRestoration /><Scripts /></body>
    </html>
  );
}
export function HydrateFallback() { return <div className="boot-splash" />; }  // required-ish in SPA mode
```

```ts
// apps/web/app/platform.ts — the equivalent of OrquesterApp's `runtime` prop
export type Runtime = "web" | "desktop";
export const desktop = typeof window !== "undefined" ? window.jasperDesktop : undefined;  // from preload
export const runtime: Runtime = desktop ? "desktop" : "web";
// Same-origin in all three cases (web behind Caddy, PWA, Electron loading the daemon URL):
export const apiBase = "";                              // relative URLs: /api, /media, /events
```

Register the SW only on web, never in Electron, mirroring `apps/web/src/pwa.ts`:

```ts
// apps/web/app/pwa.ts — call from a root useEffect
export function registerServiceWorker() {
  if (!import.meta.env.PROD || window.jasperDesktop || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
```

### 8.3 PWA for a video editor: adaptations to `sw.js` and the manifest

- Copy the structure of `apps/web/public/sw.js` (shell precache, network-first navigations, cache-first `/assets/*`, a bypass list and `Response.error()` on misses) and rename the caches to `jasper-shell-vN` / `jasper-assets-vN`.
- **Bypass list must include** `/api`, `/events`, `/ws`, `/health` and **`/media`**, plus any proxy/thumbnail/waveform/render-output URL.
  - Cache Storage cannot store `206 Partial Content`.
  - A cached 200 answering a Range request breaks seeking.
  - Media files are GBs.
- Also bypass `blob:` URLs and cross-origin requests (fonts CDN, S3). The existing code already skips cross-origin.
- RR7 SPA output is `build/client/`. The navigation fallback key stays `/index.html`, because RR7 SPA mode emits `build/client/index.html`.
- RR7 lazy route chunks are content-hashed under `/assets/`. Cache-first is fine for them.
- Manifest: `display: "standalone"` (consider `"display_override": ["window-controls-overlay","standalone"]` for desktop-installed PWAs), `orientation: "any"`, `background_color` matching the Premiere-dark palette, and **separate maskable icons** with a safe zone.
- Keep `overscroll-behavior: none`, the safe-area padding and `visualViewport` sizing, since timeline scrubbing on touch will otherwise trigger pull-to-refresh.
- **iOS:** installed-PWA storage can be evicted and there is no background render. Mobile is a **client** of a remote daemon (VPS or home machine) and never renders locally beyond `@remotion/web-renderer`/WebCodecs previews.
- CSP additions to Orquester's Caddyfile for Remotion/mediabunny/WebCodecs:
  - `media-src 'self' blob:`
  - `worker-src 'self' blob:`
  - `script-src 'self' 'wasm-unsafe-eval'` (if any wasm decoder is used)
  - `img-src 'self' data: blob:`
  - `connect-src 'self' wss: <S3 origin if kept>`
  - `font-src 'self' data: https://fonts.gstatic.com` (for `@remotion/google-fonts`)
  - If `SharedArrayBuffer` is ever needed, also add `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and set the same headers from the daemon for Electron and dev.

### 8.4 Shared UI package with Tailwind 4

Orquester's TW3 preset and `content` globs do not apply. In TW4:

```css
/* apps/web/app/app.css */
@import "tailwindcss";
@import "@jasper/editor-ui/theme.css";          /* @theme { --color-panel: …; } Premiere palette tokens */
@source "../../../packages/editor-ui/src";      /* scan the shared package for class names */
```

`packages/editor-ui/package.json`: `"exports": {".": "./src/index.ts", "./theme.css": "./src/theme.css"}` with `peerDependencies` on react 19 and remotion 4.0.499. Keep all Remotion packages pinned to one exact version across the workspace; Remotion requires identical versions.

### 8.5 `apps/desktop`: Electron shell

Decision: **do not build a second renderer**. Instead:
- **Prod:** the main process starts the daemon, then calls `loadURL("http://127.0.0.1:<port>/")`. The daemon serves `apps/web/build/client` through `@fastify/static` with an SPA fallback, exactly like Orquester's `serveWeb`.
- **Dev:** `loadURL("http://127.0.0.1:5173/")` (the RR7 dev server, which proxies to the daemon).

Advantages:
- One origin in all runtimes.
- BrowserRouter works (no `file://`).
- `<video src="/media/…">` gets native Range streaming.
- Remotion `<Player>` works unchanged.
- No IPC byte bridge is needed.

The alternative is `protocol.registerSchemesAsPrivileged([{scheme:"jasper", privileges:{standard:true, secure:true, supportFetchAPI:true, stream:true, corsEnabled:true}}])` plus `protocol.handle("jasper", …)` to serve files and proxy `/api`/`/media` to the daemon. This takes more work and has streaming edge cases. Prefer the loopback daemon origin.

Security for a loopback origin (Orquester relied on unix-socket trust instead):
- The daemon binds to `127.0.0.1` on a **random free port** (`listen({port:0})`).
- The main process generates a 32-byte token per launch and passes it to the daemon via env (`JASPER_LOCAL_TOKEN`).
- The daemon requires `Authorization: Bearer <token>` or a `jasper_session` HttpOnly SameSite=Strict cookie.
- The main process sets the cookie with `session.defaultSession.cookies.set({url, name:"jasper_session", value: token, httpOnly:true, sameSite:"strict"})` *before* `loadURL`. Media element requests then carry it automatically.
- The daemon also checks `Host` (`127.0.0.1:<port>`) to defeat DNS rebinding.

`apps/desktop/src/main.ts` sketch:

```ts
import { app, BrowserWindow, ipcMain, utilityProcess, session, shell, dialog } from "electron";
import { randomBytes } from "node:crypto";
import path from "node:path";

const isDev = !!process.env.JASPER_DESKTOP_DEV_URL;
const token = randomBytes(32).toString("base64url");
const appdir = process.env.JASPER_APPDIR ? path.resolve(process.env.JASPER_APPDIR) : path.join(app.getPath("userData"), "jasper");

function resourcesBin(name: string) {            // ffmpeg/ffprobe/fframes shipped via extraResources
  return app.isPackaged ? path.join(process.resourcesPath, "bin", name) : path.resolve(__dirname, "../../../native/bin", name);
}

async function startDaemon(): Promise<{ port: number; child: Electron.UtilityProcess }> {
  const entry = app.isPackaged
    ? path.join(process.resourcesPath, "daemon", "daemon.mjs")          // extraResources, NOT inside asar
    : path.resolve(__dirname, "../../daemon/dist/daemon.mjs");
  const child = utilityProcess.fork(entry, ["--appdir", appdir, "--port", "0"], {
    env: { ...process.env, JASPER_LOCAL_TOKEN: token, JASPER_WEB_DIR: webDir(),
           JASPER_FFMPEG: resourcesBin("ffmpeg"), JASPER_FFPROBE: resourcesBin("ffprobe"),
           JASPER_FFRAMES: resourcesBin("fframes-renderer") },
    stdio: "pipe", serviceName: "jasper-daemon"
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.on("message", (m: any) => m?.type === "ready" && resolve(m.port));   // daemon: process.parentPort.postMessage({type:"ready",port})
    child.on("exit", (code) => reject(new Error(`daemon exited ${code}`)));
  });
  return { port, child };
}

app.whenReady().then(async () => {
  // Optionally attach to an already-running daemon first (Orquester's checkExistingDaemon pattern).
  const { port, child } = await startDaemon();
  const origin = `http://127.0.0.1:${port}`;
  await session.defaultSession.cookies.set({ url: origin, name: "jasper_session", value: token, httpOnly: true, sameSite: "strict" });
  const win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1200, minHeight: 720,
    frame: false, titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: "#1d1d1d", show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false,
                      preload: path.join(__dirname, "preload.cjs") }
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(origin) && !isDev) e.preventDefault(); });
  await win.loadURL(isDev ? process.env.JASPER_DESKTOP_DEV_URL! : origin + "/");
  app.on("before-quit", () => child.kill());
});

// Desktop-only capabilities (the only IPC surface — no byte bridge):
ipcMain.handle("jasper:pick-media", async () => (await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"],
  filters: [{ name: "Media", extensions: ["mp4","mov","mkv","webm","mp3","wav","png","jpg","svg"] }] })).filePaths);
ipcMain.on("jasper:window", (e, action: "minimize"|"toggleMaximize"|"close") => { /* as Orquester */ });
```

The desktop can import local files **by path**, with no upload: the daemon registers the path in the project and serves it at `/media/:assetId`. This is the main UX advantage over web, where files are uploaded. Mirror Orquester's `runtime` switch so the UI chooses "Import (path)" or "Upload (bytes)".

Preload (`src/preload.cts`, bundled to `preload.cjs`; with `sandbox: true` it can only `require("electron")`):

```ts
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("jasperDesktop", {
  runtime: "desktop" as const,
  pickMedia: () => ipcRenderer.invoke("jasper:pick-media") as Promise<string[]>,
  revealInFolder: (p: string) => ipcRenderer.send("jasper:reveal", p),
  windowControls: {
    minimize: () => ipcRenderer.send("jasper:window", "minimize"),
    toggleMaximize: () => ipcRenderer.send("jasper:window", "toggleMaximize"),
    close: () => ipcRenderer.send("jasper:window", "close")
  }
});
```

Main-process build: copy `scripts/build-main.ts` but emit **ESM** (`format: "esm"`, `outfile: dist-electron/main.mjs`, `"main": "dist-electron/main.mjs"`), or keep CJS for main **only if** it imports nothing ESM-only. The daemon is *not* imported by main; it is a separate bundle. Build the preload separately as CJS (`format: "cjs"`, `external: ["electron"]`).

Dev script: copy Orquester's `concurrently` + `wait-on` approach.

```json
"dev": "concurrently -k \"pnpm --filter @jasper/daemon dev\" \"pnpm --filter @jasper/web dev\" \"pnpm build:main --watch\" \"wait-on http://127.0.0.1:5173 dist-electron/main.mjs && cross-env JASPER_DESKTOP_DEV_URL=http://127.0.0.1:5173 electron .\""
```

In dev, have main attach to the `tsx watch` daemon on the fixed port `47900` instead of forking (Orquester's attach pattern), so daemon HMR does not restart Electron.

electron-builder config: copy Orquester's inline block and fix its gaps.

```json
"build": {
  "appId": "com.jasper.editor",
  "productName": "JasperEditor",
  "directories": { "output": "release", "buildResources": "build" },
  "files": ["dist-electron/**/*", "package.json"],
  "extraResources": [
    { "from": "../web/build/client", "to": "web" },
    { "from": "../daemon/dist", "to": "daemon" },
    { "from": "../../native/bin/${os}-${arch}", "to": "bin" }
  ],
  "asar": true,
  "npmRebuild": false,
  "linux": { "target": ["AppImage", "deb"], "category": "AudioVideo", "executableName": "jasper-editor" },
  "win":   { "target": [{ "target": "nsis", "arch": ["x64"] }] },
  "mac":   { "target": ["dmg", "zip"], "category": "public.app-category.video", "hardenedRuntime": true, "entitlements": "build/entitlements.mac.plist" },
  "fileAssociations": [{ "ext": "jasper", "name": "JasperEditor Project", "role": "Editor" }],
  "publish": [{ "provider": "github", "owner": "JasperRaccoon", "repo": "JasperEditor" }]
}
```

- Put only runtime externals in `apps/desktop` `dependencies` (ideally none). Put everything else, including workspace packages, in `devDependencies`. That avoids Orquester's double-shipped 400 MB tree.
- The daemon's externals (`@remotion/renderer`, `@remotion/compositor-<platform>`, `sharp` if used) need their own `node_modules`. Produce them with `pnpm deploy --filter @jasper/daemon --prod apps/daemon/dist-deploy` and ship that folder via `extraResources` (`"from": "../daemon/dist-deploy", "to": "daemon"`). Code in `extraResources` lives outside asar, so binaries are executable.
- **Auto-update** (Orquester has none): add `electron-updater` and call `autoUpdater.checkForUpdatesAndNotify()` in the packaged app, with GitHub releases as the `publish` target. AppImage, NSIS and mac zip support it; `.deb` does not.
- **Signing:** mac needs a Developer ID and notarization (`notarize: true` plus the `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` env vars). Windows needs a certificate, or use Azure Trusted Signing. Linux AppImage needs none.
- The Electron binary is ~100 MB of the package. Target under 400 MB total, including static ffmpeg (~80 MB) and chrome-headless-shell (~100 MB, for Remotion renders).

### 8.6 `apps/daemon`: local media server

Copy Orquester's shape:
- `startDaemon(options)` returning `{port, stop}`;
- a `cli.ts` with graceful SIGTERM handling;
- a `createServer(…, {authRequired, mode, serveWeb})` factory;
- `Broadcaster` + `GET /events` NDJSON with a heartbeat;
- `@fastify/static` `wildcard:true` + SPA fallback;
- `/health`;
- appdir via `packages/config`;
- bcrypt-salt login for the remote mode.

Change the following:

| Orquester | JasperEditor daemon |
|---|---|
| unix socket (local) + optional TCP | **TCP only.** Local mode binds `127.0.0.1:0` with the per-launch token (desktop); remote mode binds `127.0.0.1:47900` behind Caddy with password → bearer (VPS/PWA). Keep Orquester's "remote mode is opt-in / hot-reloadable" idea for LAN access from a phone. |
| run via `tsx` (no build) | Dev: `tsx watch`. Packaged desktop: **esbuild ESM bundle** `dist/daemon.mjs` with externals for anything with binaries or dynamic requires. VPS: `tsx` like Orquester, or the same bundle. |
| in-process in Electron main | `utilityProcess.fork` (reports readiness through `process.parentPort`). Heavy work runs in child processes: ffmpeg/ffprobe via `child_process.spawn`, fframes as a Rust CLI (`native/fframes-renderer`, stdin JSON → mp4/png sequence), Remotion via `@remotion/renderer` `renderMedia()` (spawns its own compositor + headless Chrome). |
| `/ws` for terminals | `/ws` optional (e.g. scrubbing preview frames); job progress rides `/events` (`job.progress`, `job.done`, `asset.proxy.ready`, `waveform.ready`). |
| file routes for text files | **Media routes with Range**: `GET /media/:assetId` (original), `/media/:assetId/proxy` (low-res H.264 proxy), `/thumbs/:assetId/:t.jpg`, `/waveforms/:assetId.json`. Use `@fastify/static`'s `send` (supports Range) or `reply.sendFile` from per-project dirs. |
| uploads as raw octet-stream with 500 MB cap | Keep the raw-binary streaming-upload pattern (`binaryBody` → `application/octet-stream`, metadata in the query string, `Content-Length` precheck) for web/PWA; raise or remove the cap. The desktop registers local paths instead. |
| — | Replace the RR7 `api/render` (Lambda), `api/upload` (S3) and `api/captions` (OpenAI) routes with daemon routes; keep S3/Lambda as optional "cloud" providers behind config. |

Remotion in the daemon:
- `@remotion/bundler`'s `bundle()` (webpack) needs source files at runtime, so it cannot live inside an asar. Pre-bundle compositions at build time (`remotion bundle` → `apps/daemon/dist/remotion-bundle/`) and pass that serve URL to `selectComposition`/`renderMedia`.
- Call `ensureBrowser()` into `<appdir>/browser` on first run, or ship chrome-headless-shell in `extraResources`.
- Remotion ships its own ffmpeg inside `@remotion/compositor-<platform>`. The native engine may reuse it or ship a separate static ffmpeg.
- Other engine docs cover the details.

### 8.7 VPS / remote web and PWA deployment

- Copy `deploy.sh`, `deploy/lib/{common.sh,remote-update.sh,remote-provision.sh}`, `deploy/targets.conf.example`, `DEPLOY_TO_VPS.md.example`, `deploy/Caddyfile` and the systemd unit, and rename `orquester` to `jasper`.
- In `remote-update.sh`, change the build step to `pnpm --filter @jasper/web build` and set the health URL to port 47900.
- Add `ffmpeg` to provisioning (`apt-get install -y ffmpeg`, or a static build). The Rust toolchain is only needed if fframes is built on the box; prefer shipping prebuilt binaries.
- In the Caddyfile, add `request_body { max_size 20GB }` (or rely on a tus/chunked upload) and the CSP changes from §8.3. Caddy streams Range responses fine.
- In the systemd unit, drop the tmux, `KillMode=process` and sudo carve-outs. Set `Environment=TMPDIR=/var/lib/jasper/tmp`, and consider `CPUWeight`/`Nice=5` so renders do not starve the API.
- Keep `ELECTRON_SKIP_BINARY_DOWNLOAD=1` on server installs.
- Keep `scripts/smoke-web.mjs`, pointing at an element that exists in the editor shell.

### 8.8 Step-by-step order of work

1. Convert the repo to a pnpm workspace:
   - add `pnpm-workspace.yaml` and `tsconfig.base.json`;
   - delete `package-lock.json`;
   - set `packageManager: pnpm@10.x`;
   - move `src/editor` → `packages/editor-ui`, `src/remotion` → `packages/compositions`, and the rest → `apps/web`.
2. `apps/web`: switch RR7 to `ssr:false`, remove `@vercel/react-router`/`@react-router/serve`/`@react-router/node`, move `routes/api/*` into `apps/daemon`, and add the Vite `server.proxy`.
3. `apps/daemon`: Fastify skeleton with `startDaemon`/`cli.ts`/`/health`/`/events`/static SPA serving and a token or password auth hook, plus the `packages/config` appdir (`.stage` for dev).
4. `packages/api`: zod contracts for assets, jobs and events. Build a small `ApiClient` + `Transporter` (fetch-based; one implementation suffices because every runtime is same-origin HTTP).
5. PWA: `public/manifest.webmanifest`, `public/sw.js` (with the `/media` bypass), icons (including padded maskable ones), `theme-boot.js`, and `pwa.ts` registration gated on PROD and not-desktop.
6. `apps/desktop`: `main.ts` (fork the daemon, set the token cookie, `loadURL`), `preload.cts`, esbuild main/preload builds (ESM main), the electron-builder config with `extraResources` and without double-shipped deps, then `electron-updater`.
7. Deployment: `deploy/` + `deploy.sh` + Caddy CSP + systemd.
8. CI: `pnpm check` and `pnpm test`, plus a `pnpm --filter @jasper/desktop build` matrix (linux/win/mac) that uploads to GitHub releases.

---

## 9. Do NOT copy (Orquester-specific or defective)

- **Defective:**
  - The in-process daemon bundled with esbuild `format:"cjs"`. The current `dist-electron/main.cjs` throws on load because of `import.meta.url`.
  - `webDir = <repoRoot>/apps/web/dist` in `startIntegratedDaemon`, which is invalid when packaged.
  - Shipping all daemon dependencies plus build tools (vite, tailwind, react) as desktop `dependencies`, which gave a 402 MB AppImage.
  - No `setWindowOpenHandler`/`will-navigate` guards and no `sandbox:true`.
  - `dev:web` relying on cross-origin calls without CORS.
  - One PNG reused as the `maskable` icon.
- **Unsuitable for video:**
  - The unix-socket + IPC byte bridge (`preload.cjs` `request`/`requestBytes`/`stream*`, `UnixSocketTransporter`, `NodeHttpClient`). It buffers entire bodies and cannot back `<video>` Range requests.
  - The separate desktop renderer Vite app.
- **Product-specific:**
  - tmux / node-pty / `scripts/fix-node-pty-perms.mjs`, `KillMode=process`;
  - the agent host, agent chat, MCP (`/mcp`), workflows, git accounts and SSH keys;
  - Design Mode / puppeteer browsers / DevTools proxy and its Caddy CSP island;
  - `packages/registry`, `better-sqlite3` (unless needed);
  - `deploy/provision-devtools.sh`, `deploy/devtools-user.sh`, `sudoers.d/orquester-pkg`, and `NoNewPrivileges=false` plus the wide `ReadWritePaths`;
  - the `opencode.env.example` proxy;
  - `ORQUESTER_REMOTE_URL`-seeded remotes (unless a "connect to render server" feature is wanted);
  - the tray HTTP toggle.
- **Keep, but re-brand:** the `theme-boot.js` localStorage key (`orquester:theme`) and scheme list, the `orquester:*` IPC channel names, `com.orquester.desktop`, and port `47831`. Use `47900` or another distinct port so both apps can run on one machine.
- **Secrets:** never commit `daemon.env`, `targets.conf` or the real `DEPLOY_TO_VPS.md`. Orquester's `.gitignore` entries for these (`.env.*`, `/.secrets/`, `/deploy/targets.conf`, `/DEPLOY_TO_VPS.md`, `.stage/**/logs/`, `*.sock`) should be copied.

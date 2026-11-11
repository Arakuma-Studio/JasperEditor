# HTML compositions — self-contained HTML/GSAP pages as composition clips

Branch `feat/html-composition`. Builds on the Remotion bundle clips of `wp-m2-mg.md` (S08, ARCHITECTURE §19.3, D-26):
an HTML page is one more kind of `mg-bundle`, so placement, props-less composition clips, masters, previews, posters,
stills (`render_frame`), native exports, the Remotion export path, the cache and relinking are the existing ones.

## The contract

A page is an HTML composition when it defines, from its own scripts (before or shortly after `load`):

| Global | Meaning |
|---|---|
| `window.__duration` | length in seconds: a finite number, `0 < d ≤ 3600` |
| `window.__ready` | a Promise (or a function returning one) that settles when fonts and images are loaded |
| `window.__seek(t)` | puts the whole page at time `t` seconds; pure and deterministic (may return a Promise) |

Parameters come from the query string given at import (`location.search`, e.g. `?s=2`); a composition has no props.
The page sees `navigator.webdriver === true` (the driven mode of Puppeteer and Remotion renders), in the editor too:
pages commonly play themselves in real time when it is false (the sample carousel does). Composition frame `f` at
render rate `fps` is `__seek(f / fps)`, so a page renders exactly at any sequence rate (no `MG_FPS_MISMATCH` warning).
What the page does not paint is transparent (straight alpha): a page without a background is an overlay.

Errors (engine `MgBundleError` → HTTP 4xx → MCP error result, each with a hint naming the fix):

| Code | When | Detail |
|---|---|---|
| `HTML_NOT_A_PAGE` | the path is not an `.html`/`.htm` file (e.g. its folder), or the page loads > 20 000 files / > 2 GiB | — |
| `HTML_CONTRACT_MISSING` | a global is missing 3 s after `load` (30 s at most) | `missing`, `pageErrors` (first 5 uncaught errors with `file:line`, page lines counted without the injected bootstrap) |
| `HTML_DURATION_INVALID` | `__duration` is not a finite number of seconds in range | `duration` |
| `HTML_READY_FAILED` / `HTML_READY_TIMEOUT` | `__ready` rejected / did not settle in 30 s | `reason` / `timeoutMs` |
| `HTML_SEEK_FAILED` | `__seek(t)` threw (checked at the first, middle and last frame on import; any frame on render) | `t`, `reason` |

## Where it lives

| Piece | Where |
|---|---|
| Document model (schema v13) | `packages/project/src/schema/media.ts` (`MgHtmlPageSchema`, `mgHtmlPageIssue`, `MgBundleInfo.html`, source type `html-page`), `migrations.ts` (`v12→v13` bump), `invariants.ts` (INV-MG-HTML, repair `drop-html-page`), `commands/handlers/project.ts` (`media.register` / `media.relink` refuse a bad header with `E_SCHEMA`), `render/snapshot.ts` (`bundle.html {entry, query}`), fixture `test/fixtures/schema-v13.jasper` |
| API | `packages/api/src/mg-bundles.ts` (`MgHtmlImportRequestSchema`, `HTML_*` codes), route `mgBundleImportHtml` = `POST /api/mg-bundles/import-html` |
| Host agent | `packages/compositions/src/mg-host/html-agent.ts` (runs inside the page: contract, `__ready`, `__seek` + two animation frames; the MessagePort API of `agent.ts` for the live host and `window.__jasperHtmlHost` for the engine), `protocol.ts` (`injectHtmlHostBootstrap`, `htmlHostPageUrl`) |
| Live host (Program monitor) | `packages/compositions/src/layers/CompositionLayer.tsx`: the sandboxed iframe loads the page (`/mg/bundles/<key>/<entry>?<query>&jasper-host=1` → capability path) instead of a Remotion `index.html`; everything else (preview WebM when ready, budget, chips) unchanged |
| Engine | `apps/engine/src/mg-bundles/html.ts` (probe, parallel ProRes render, still), `service.ts` (`importHtml`, `importHtmlPage`, html branches of rebuild / watch / `runHtmlPrerender` / poster), `csp.ts` (the sandbox policy, shared), `routes/mg-bundles.ts` (route, sandbox serving of the entry with its query, headless relink) |
| MCP | `apps/mcp/src/tools/compositions.ts` `import_html_composition {projectId, path, width, height, fps, query?, watch?}` → `{mediaId, compositions:[{id,…}]}`; place with `add_composition {mediaId, compositionId}` like any composition; `list_compositions` shows `source: "html-page"` and `query`. Eval cases `apps/mcp/eval/cases/compositions.jsonl` |
| Web | File ▸ Import HTML Composition… (`mg-bundles/ImportHtmlDialog.tsx`, command `mg.importHtmlComposition`), Motion Templates ▸ Remotion lists the pages with an "HTML" badge and a Reload button, Properties ▸ Composition "Page" + "Reload page", Project panel item menu "Reload HTML Composition" |

## How it works

- **Import** (job `mg-bundle`, op `import-html`): the page's folder is served by a private loopback server (random port,
  unguessable prefix, paths outside the folder refused; symlinks inside it are followed) with the live host's
  Content-Security-Policy (`sandbox allow-scripts`, own files, `data:`/`blob:`, `https:` — scripts included for
  CDN-loaded GSAP — and `Access-Control-Allow-Origin: *` because the sandboxed document has an opaque origin). The Remotion
  headless browser (same executable and chrome mode as `renderMedia`; own windows for Chrome for Testing) loads
  `<entry>?<query>&jasper-host=1` at `width`×`height`, the agent checks the contract, waits for `__ready`, reads the
  duration and seeks the first, middle and last frame. Every file of the folder the page requested (until the server
  is idle for 300 ms) is copied into `<appdir>/mg-bundles/<hash>/`, `hash = sha256({files hash, entry, query, width,
  height, fps})`; files the page asked for but that do not exist and remote `https:` resources are logged as warnings.
  One composition: id = the file name without extension, `round(__duration × fps)` frames, `defaultProps {}`, a props
  schema that accepts none, `thumbnailFrame` = the middle frame.
- **Render** (`mg-prerender`, `runHtmlPrerender`): the request's range is split into contiguous ranges, one per page
  (the job's tab budget, 1–8; inside an export the page pool's share). Each page: `__seek(f/fps)`, two animation
  frames, `Page.captureScreenshot` PNG with a transparent default background (Remotion's screenshot task), piped into its
  own LGPL FFmpeg: `scale=out_color_matrix=bt709:out_range=tv` → `prores_ks` 4444 `yuva444p10le`, BT.709 tags. The
  segments are joined with the concat demuxer (stream copy) and the frame count is checked. `master` keeps it as
  `master.mov` (+ the VP9-alpha preview); `preview` encodes only `preview.webm`. Posters are one still scaled to ≤ 480 px.
- **Watch** (`watch: true`): the files of the bundle (what the page loaded) are watched through their folders (editors
  save by replacing files); 1 s after the last change the page is re-imported. A new key publishes `mgBundle.rebuilt` (an
  open editor relinks as a system edit, as for Remotion projects) and projects that imported it with watch and that no
  editor has open are relinked headlessly (`media.relink` transaction "Reload HTML composition"). One page may be
  watched once per query. Since this change the headless relink also applies to watched Remotion projects.
- **Schema v13**: `mgBundle.html` and source type `html-page` would be misread by v12 (it would drive the page with the
  Remotion protocol and its strict source enum refuses the value), so v12 builds open v13 files read-only.

## Verification (run on this host, Linux, shared and loaded)

- `pnpm exec vitest run packages/project/test/html-composition.test.ts packages/project/test/schema-history.test.ts packages/project/test/composition.test.ts` — header refusal, damaged-header repair, snapshot, v13 fixture.
- `pnpm exec vitest run apps/engine/test/html-composition.test.ts` (route validation; sandbox serving keeps the query,
  injects the HTML agent, allows CDN scripts) and with `MG_E2E=1` (real Chrome + FFmpeg): import of
  `fixtures/html-composition` (only the three loaded files copied), `HTML_CONTRACT_MISSING` naming `__seek`, the page
  error and its line; `render_frame`'s still path; a native export frame-exact (box edge within 1 px of where each
  frame's time puts it, 31 px per frame) with the frame before the clip pure background; the master's straight alpha;
  watch + headless relink after a `.js` save (duration 2 → 3 s, 60 → 90 frames). 6/6 pass.
- `MG_E2E=1 pnpm exec vitest run apps/engine/test/mg-bundles.test.ts`: 19/19 (Remotion bundles unchanged after the
  shared prerender / watch refactor). `apps/engine/test/security-hardening.test.ts` passes.
- Real case: the Instagram carousel `pano.html` (GSAP from `node_modules`, `face_topo.js`, fonts, images; copied to a
  temp dir) through MCP over stdio against a dev engine: import `?s=2` at 1080×1350 / 30 fps → 180 frames, 13 files
  copied; a transparent overlay page above it; `render_frame` at 1 s and 4 s; a 3 s H.264 export; a page without
  `__seek` and a folder path refused with their hints; a CSS save picked up by watch and relinked headlessly.
  Fidelity: the live host page in the user's Chrome at frame 30 vs the engine master frame 30: SSIM 0.99898, PSNR
  57.9 dB (ProRes encoding only). The export frame vs `render_frame` at the same time: SSIM 0.912, of which H.264 alone
  (the still encoded at CRF 18) accounts for 0.922 — the page's full-frame grain texture.
- Timings (measured, host load average ≈ 12–39 from other agents, so upper bounds): import probe 1–4 s idle-ish, 10–12 s
  at load ≈ 35; 60 frames at 1920×1080 with 4 pages 13 s; 60 frames of `pano.html` at 1080×1350 with 4 pages 36 s
  (load ≈ 12); the 3 s carousel export with two HTML clips (150 master frames) 375 s at load ≈ 32–39; a `render_frame`
  still 11–40 s (each still loads the page in a fresh browser).
- UI: the editor at port 47202 showed both clips in the Program monitor from their live hosts (state `ready` at frame
  0) and, after the preview WebMs landed, from those (`idle` hosts) at 1 s; the web build typechecks; `pnpm i18n`,
  Spanish strings added (`pnpm i18n:check` covers all strings).

## Limits

- No props: a page's parameters are its import query; another query is another import (another media item).
- Only files the page loaded while being probed (load, `__ready`, three seeks) are in the bundle; a file first
  requested at another time is missing in renders (404) — the contract asks `__ready` to wait for assets. Remote
  `https:` resources are loaded at render time (network needed; they may change).
- Files outside the page's folder (`../x.js`) are refused (sandbox); symlinks inside it are followed.
- Stills are slow (a fresh browser and page load per still); renders capture PNG frames (no faster path for opaque
  pages, so alpha always works).
- The live host is a sandboxed iframe in the editor's browser: GPU / WebGL behaviour may differ from the headless
  renderer the way it does for Remotion bundles; colour effects wait for the preview WebM ("Grade pending").
- Importing reads a path on the engine's computer: local engines only (the dialog says so; no upload path).
- The desktop app has no file picker in the dialog (path field only).

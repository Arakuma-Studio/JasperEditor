# WP-2F — Engine core: notes for integrators and WP-2G / WP-2H

Branch `wp/wp-2f`. Everything here is under `apps/engine` (plus this file). No contract changes: `@jasper/api`
is used as-is (no `Contract-Change:`).

## What exists

| Area | Where | Notes |
|---|---|---|
| Service wiring | `src/tools/services.ts` | `createCoreServices(config)` runs in `createServer` (server.ts, additive). Plugins get them with `coreServices(app)`. `app.jasper.services` also exposes `core`, `jobs`, `broadcaster`, `mediaRegistry`, `projects`, `ffmpeg`. The queue starts in the `onReady` hook (after every plugin registered its runners) and shuts down in `onClose`. |
| Auth | `src/auth/signed-url.ts`, `server.ts` | WP-00 Host/Origin/token checks unchanged. New: HMAC signed URLs `?sig=&exp=` for `/media/*`, `/fonts/*`, `/renders/*`, `/mg/*` (S04:MS-003). A valid signature bypasses the token and Origin checks (not the Host check), adds `Access-Control-Allow-Origin: *` and answers CORS preflights, because Remotion's headless browser fetches cross-origin from its own bundle server and cannot send the cookie. The secret is the local token, or a random per-process secret. |
| Events | `src/events/broadcaster.ts`, `routes/events.ts` | NDJSON `GET /events`, monotonic ids, 2000-event ring buffer, `?since=` replay, `?projectId=` filter (events without a projectId are global), an initial heartbeat, then one every 15 s. Heartbeats carry the current last id and are not buffered. |
| Jobs | `src/jobs/{queue,types}.ts`, `routes/jobs.ts` | Lanes `interactive > user > background` (FIFO within a lane); CPU slots = cores; `minSlots` lets exports start with ≥ half; background lane paused while an export runs; dedupe keys; cancel = abort signal + process-group SIGTERM → SIGKILL after 3 s, partials removed, forced `cancelled` at 4.5 s; retry = new job; `jobs.jsonl` journal (compacted on start, 500 / 7 days kept); restart: running → `interrupted`, interrupted artifact jobs (probe/keyframes/poster/sprite/peaks/proxy/mg-render) re-queued once; `job.updated` ≤ 4/s per job plus forced state changes, then `job.finished`. Failure logs: `<appdir>/engine/logs/jobs/<jobId>.log` (`error.logRef`). |
| ffmpeg | `src/tools/ffmpeg.ts`, `src/tools/process.ts` | Resolution `JASPER_FFMPEG`/`JASPER_FFPROBE` → `<JASPER_RESOURCES_DIR>/bin` → PATH. `Ffmpeg.run(args, {signal, onProgress, onSpawn})` adds `-progress pipe:1`. Self-check (cached per binary pair) lists versions, encoders, filters and missing required ones. All tools spawn with argument arrays, in their own process group. |
| Capabilities | `src/tools/capabilities.ts`, `routes/capabilities.ts` | `render.native` from the self-check, `render.remotionLocal` from `RemotionService.state()`, `render.fframes` defaults to `unavailable` until a provider patches it. |
| Media | `src/media/{fingerprint,probe,registry,service}.ts`, `routes/media.ts` | `q1:` fingerprint, `mk_` + 24 hex keys, `engine/media-index.json` (atomic), ffprobe → S01 `MediaProbe` + `browserPlayable`, offline by size/mtime, `POST /api/media/register` (bounded parallelism 4), `GET /api/media/:key`, `POST /api/media/:key/derivatives`. Probes run as `probe` jobs in the interactive lane (visible in the Jobs panel) and the route waits for them. |
| Uploads | `src/uploads/service.ts`, `routes/uploads.ts` | Sessions in `<appdir>/media/.uploads/<uploadId>/`, disk-space check (507 `DISK_FULL`), 409 `UPLOAD_OFFSET_MISMATCH` with `{expectedOffset}`, oversize chunks rolled back (400 `UPLOAD_SIZE_MISMATCH`), 24 h idle expiry (hourly sweep). Completion moves the file to `<appdir>/media/<mediaKey>/<name>`, probes it and queues derivatives. |
| Derivatives | `src/derivatives/{service,peaks}.ts` | `cache/<fpHex>/<kind>-<paramsHash>.<ext>`; keyframes JSON, poster JPEG (320 px at 10 %), sprite (`sprite-<h>.json` + `sprite-<h>/<n>.jpg`, 160 px tiles, 10×10 per sheet), peaks (`peaks-<h>.json` + `peaks-<h>/<stream>.bin`), proxy-720/540 (H.264 GOP 15, faststart, AAC 128k, rotation baked by autorotate). Auto-queued after registration (IN-011; proxy-720 only when `browserPlayable = no`). `derivative.ready {mediaKey, kind, url}` events; URLs carry `?v=<paramsHash>`. |
| Serving | `src/tools/http.ts` | `/media/:key` (no-cache + ETag), `/media/:key/proxy/:tier`, `poster.jpg`, `keyframes.json`, `sprite.json`, `sprite/:n(.jpg)`, `peaks.json`, `peaks/:stream(.bin)` (immutable). HEAD, single Range → 206, suffix ranges, 416, If-None-Match/304, If-Range, streaming. |
| Projects | `src/projects/{store,leases}.ts`, `routes/projects.ts` | Envelope in `projects/<id>/project.jasper` (tmp + fsync + rename + dir fsync), view file, versions under `versions/` (at most one per 5 min of saving, newest 20 kept), `If-Match` → 409 `REVISION_CONFLICT {revision}`, in-memory leases (30 s TTL, 10 s heartbeat hint, 409 `LEASE_HELD {holderSessionId, expiresAt}`). |
| Export | `src/export/{planner,native,service}.ts`, `routes/exports.ts` | Planner → S04:RP-010 plan with per-clip blockers and warnings (`OFFLINE_MEDIA`, `VFR_SOURCE`, `FONT_FALLBACK`, `FRAME_RATE_CONVERSION`, `UNSUPPORTED_KIND`, …); `planId` deterministic over revision + document hash + settings + capabilities. Native builder per S03:ENG-030. Remotion path via `RemotionService`. Outputs in `renders/<jobId>/output.mp4`; frame counts verified with ffprobe (`FRAME_COUNT_MISMATCH`); `export.finished` event; `GET /renders/:jobId/output` with Range (`?download=1` adds Content-Disposition). |
| Remotion | `src/remotion/service.ts` | Bundles `@jasper/compositions/remotion-entry` into `<appdir>/remotion/bundle/<sourceHash>` (hash of Remotion version + `src/` of compositions, project, mg-templates; ~10 s, cached; last 3 kept). Packaged engines use `dist/remotion-bundle` (next to `engine.mjs`) or `JASPER_REMOTION_BUNDLE`. Browser: `JASPER_BROWSER_EXECUTABLE` → Remotion's downloaded headless shell → system Chrome (`/usr/bin/google-chrome`, run with `chromeMode: 'chrome-for-testing'`) → otherwise `needs-browser-download` (Remotion downloads on first render). License key `JASPER_REMOTION_LICENSE_KEY` on every call; each render call is appended to `engine/logs/remotion-usage.jsonl` (S04:LC-004). Delay-render timeout 60 s → `RENDER_TIMEOUT`. |
| Stills | `routes/stills.ts` | `POST /api/stills` → `still` job; native single-frame PNG when the frame is media-only, else Remotion `renderStill`; result `{url: '/renders/<jobId>/output', renderPath}`. |
| Fonts | `src/fonts/catalog.ts`, `routes/fonts.ts` | 10 @fontsource families (latin + latin-ext woff2, all weights/styles), `GET /api/fonts`, `GET /fonts/<id>/<file>.woff2` (immutable). `resolve(family, weight, italic)` picks the nearest weight; unknown families fall back to Source Sans 3 (`FONT_FALLBACK`). |
| Build | `scripts/build.mjs` (unchanged), `scripts/build-remotion.mjs` | `pnpm --filter @jasper/engine build` → `dist/engine.mjs` (Remotion stays external; the peak worker is an eval'd worker, so it survives bundling). `pnpm --filter @jasper/engine build:remotion` → `dist/remotion-bundle` + `dist/fonts` for packaged use (not part of `build`; the desktop packaging step should run it). |

## Service hooks for WP-2G (motion graphics)

```ts
import { coreServices } from '../tools/services.ts'; // or from '@jasper/engine' index exports

export default async function mgRoutes(app: FastifyInstance) {
  const core = coreServices(app);

  // 1. Capability: render.fframes (S04:RT-002). Return a patch; re-evaluated on every GET /api/capabilities.
  core.registerCapabilityProvider(() =>
    mg.ready ? { render: { fframes: 'ready' } } : { render: { fframes: 'unavailable', fframesReason: mg.reason } });
  // Call core.capabilities.changed() when the state flips later (emits capabilities.changed).

  // 2. Jobs: register the runner BEFORE the server is ready (i.e. inside the plugin).
  core.queue.registerRunner('mg-render', async (ctx) => {
    // ctx.input (journaled, JSON), ctx.signal (abort on cancel/shutdown), ctx.slots,
    // ctx.progress(p, {stage}), ctx.trackChild(child), ctx.addPartial(path), ctx.scratchDir(), ctx.log(text)
    // Spawn with core.ffmpeg.spawnRaw(...) or spawnTool(bin, args, {signal: ctx.signal, onSpawn: ctx.trackChild})
    return { key, url };
  });
  const job = core.queue.submit({ kind: 'mg-render', title: 'Lower third', priority: 'user', cpuSlots: 4,
    dedupeKey: `mg:${renderKey}`, input: { spec, quality } });
  const done = await core.queue.wait(job.id);

  // 3. Native export: masters for motion-graphic clips. Return an absolute path of a straight-alpha
  //    ProRes 4444 (or any ffmpeg-readable alpha) file whose frame 0 is the clip's first frame and whose
  //    size is the clip canvas (`clip.intrinsicBox`), at `fps`; or null → the export falls back to Remotion
  //    (engine 'auto') or fails with PATH_NOT_ELIGIBLE (engine 'native').
  core.registerMgMasterProvider(async ({ clip, fps, sequence, projectId, signal }) => pathOrNull);
}
```

The planner only chooses `native` for motion-graphic clips when `render.fframes === 'ready'` **and** a master
provider is registered. Masters are requested at export time (job stage "Rendering motion graphics").
`clip.source.mg = {template, params, canvas}`, `clip.duration`, `clip.sourceIn` (flicks) are on the
`RenderVisualClip`.

## Service hooks for WP-2H (agents, desktop)

- **Projects:** `core.projects` (`ProjectStoreFs`): `loadDocument(projectId) → {document, revision, readOnly}`
  and `saveDocument(projectId, document, {baseRevision})` for headless transactions (409 `REVISION_CONFLICT`
  when stale); `core.leases.get(projectId)` tells whether an editor session holds the project (relay vs
  headless). Errors are `ProjectError {code, status, detail}`.
- **Events:** `core.broadcaster.publish('doc.changed', payload, projectId)` (and `agent.approval.*`) reach
  `/events` subscribers.
- **Stills for `frame.capture`:** `core.exports.still({envelope, sequenceId, frame, width?}, {type: 'agent',
  agentRunId})` → job; `core.queue.wait(job.id)` → `result.url`.
- **Exports:** `core.exports.plan(req)` / `core.exports.start(req, origin)`.
- **Media:** `core.media.registerPath(path, {projectId})` (local mode) and `core.registry` (`mediaKey →
  record`).
- **Desktop packaged mode:** set `JASPER_LOCAL_TOKEN`; ship `dist/remotion-bundle` and `dist/fonts` next to
  `engine.mjs` (`pnpm --filter @jasper/engine build:remotion`), optionally ffmpeg in
  `<JASPER_RESOURCES_DIR>/bin`, and `JASPER_BROWSER_EXECUTABLE` for the bundled headless browser.

## Decisions and deviations

- **Rotation convention:** `probe.rotationDegrees` is ffmpeg's display-matrix angle normalized to
  0/90/180/270 (counter-clockwise, as `ffprobe` reports it; the legacy clockwise `rotate` tag is negated).
  The fixture made with `-display_rotation 90` therefore reports 90, a typical phone portrait clip reports 270.
  Consumers only need it to swap the box; browsers and ffmpeg (autorotate) apply it themselves. A browser
  prober (M2, mediabunny reports clockwise) must convert.
- **Peaks binary layout:** `peaks/<n>.bin` is planar little-endian float32 (channel 0 peaks, then channel 1…),
  `sampleCount` per channel; header adds `layout: 'planar-f32le'` and `version`.
- **Sprite:** interval `max(1 s, duration/200)` (20 frames for animated images); the per-keyframe mode of
  S04:TH-002 is not implemented. Index adds `sheets`, `intervalSec`, `version`.
- **Extra route:** `GET /media/:key/keyframes.json` (the `keyframes` derivative needs a URL for
  `derivative.ready`).
- **Status codes:** `POST /api/projects` and `POST /api/uploads` answer 201; `POST /api/exports` and
  `POST /api/stills` answer 202 (bodies as in `@jasper/api`). `PUT /api/projects/:id` without `If-Match` → 428;
  `If-Match: *` forces the save. Stored revision = `max(envelope.revision, current + 1)` (the session's own
  revision normally wins, so `EngineProjectStore` keeps working unchanged).
- **Native path coverage (M1):** video/still/solid (+ motion-graphic with masters); static transform, opacity,
  crop and flip effects; constant forward speed (setpts/atempo); gain/volume (clip + track + master, static);
  offline media renders as a dark-red card (no text: ffmpeg text filters are banned by S04:SC-004).
  Blocked (→ Remotion): text/other kinds, keyframes, blend modes, other effects, reverse, transitions, audio pan
  and audio effects, animated levels.
- **Remotion path (M1):** renders at the sequence frame rate and aspect (warnings `FRAME_RATE_IGNORED`,
  `SIZE_IGNORED`); audio comes from Remotion (S04:RP-006 native mix is M2).
- **Colour:** layers are composited in RGB; untagged HD sources are read as BT.709 (browser behaviour), output
  is BT.709 TV range, tagged.
- **Media URLs for renders:** `http://127.0.0.1:<port>/media/<key>?sig=…&exp=…` (6 h TTL).
- Review hardening: signed URLs (`?sig=&exp=`) only authorize GET/HEAD/OPTIONS; `settings.destination
  {type:'path'}` requires an absolute file path and local mode (403 LOCAL_MODE_ONLY otherwise, like path
  registration); `GET /renders/:jobId/output` answers 404 until the job has succeeded (no partial files).

## TODO (not done in this package)

- HDR tone-mapping and VP9-alpha proxies for alpha sources (S04:PX-001); poster black-frame skipping (TH-001);
  large-image display copies (TH-004).
- Cache LRU eviction and quota (S04:CA-003); automatic single retry of transient background failures (JB-022);
  `GET /api/jobs/:id/log` and job deletion routes (not in the M1 contract).
- Segmented/parallel native renders and concat for long timelines (S04:RN-023), smart render (RN-010),
  loudness normalization (RN-032), hybrid alpha intermediates (RP-003) — M2 per ARCHITECTURE D-11.
- `media.updated` is only published at registration (`processing`); readiness is reported per derivative via
  `derivative.ready`.
- Relink routes (S04:AS-011) and path registration restricted to media roots for remote mode (M2).

## Verification (this worktree)

- `pnpm install && pnpm fixtures && pnpm lint && pnpm typecheck && pnpm test` → all green
  (29 files, 207 tests; engine: 8 files / 61 tests, Remotion e2e skipped unless `REMOTION_E2E=1`).
- `REMOTION_E2E=1 pnpm vitest run apps/engine/test/remotion.e2e.test.ts` → 30-frame text-only render verified
  with ffprobe, plus a Remotion still (system Chrome 150, ~11 s including bundling).
- `pnpm --filter @jasper/engine build` and `build:remotion` succeed; the bundled `node dist/engine.mjs` serves
  capabilities, fonts, registration and derivative jobs.
- Manual: `JASPER_APPDIR=./.stage JASPER_DEV=1 tsx apps/engine/src/cli.ts --port 48600` then
  `curl http://127.0.0.1:48600/api/capabilities` → `render: {native: true, remotionLocal: 'ready', fframes:
  'unavailable'}`. (`pnpm dev:engine` itself could not bind 47900 on this shared host because another
  worktree's engine was already listening there.)

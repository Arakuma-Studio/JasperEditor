# Performance hunt: optional browser runtimes

The production entry's generic `vendor` chunk contained the PDF reader and worker, QuickJS with its embedded
WebAssembly, Lottie player and DOM screenshot library. All four already had dynamic imports at their call sites
(`VectorLayer.tsx`, expressions `runtime.ts`, layers `lottie.ts`, `ui-automation.ts`), but `vite.config.ts` assigned
all uncategorized dependencies to one eagerly imported chunk. Home and ordinary editing therefore downloaded and
evaluated these libraries before any feature needed them. These findings come from the repository's call sites,
the built import graph and source maps; no third-party implementation was ported.

The change gives these four runtimes separate vendor chunks. Their existing import promises, callers and error
handling are unchanged. CodeMirror was investigated too: its consumers are currently eager, so moving it to a
separate chunk did not remove its bytes from the initial graph and was left out.

Offline first use stays available. Production service-worker registration already waits for window load. Its
install now warms a generated list of optional chunks and their recursive static imports, without evaluating
those modules in the page. Hashed assets use the HTTP cache when present. A failed optional download does not
prevent the worker or the other assets from installing. The asset-cache limit grows from 80 to 84 entries to
allow the four additional runtime chunks; the generated list script is a worker dependency. A previously visited
editor can still evaluate expressions and render DOM screenshots offline. PDF and Lottie chunks also import
offline. A new worker cache version removes the previous version on activation, following the existing lifecycle.

Measurements are in [bundle-hunt.results.json](../../apps/web/bench/bundle-hunt.results.json). Both production
builds used Node 22.23.4 / pnpm 10.34.5 on the same Linux AMD EPYC-Genoa host (8 logical CPUs). The original build
is commit `8b4c8936`; both builds used the frozen lockfile. Browser runs alternated before/after four times, each
with a fresh Chromium 153 context, identical viewport and authentication harness, service workers blocked for
critical-graph measurement. Host load at the end was 13.17 / 9.29 / 4.23. Compression uses the same Node version
for both outputs: gzip defaults and Brotli quality 5. Values below are measured bytes, excluding source maps,
fonts and CSS.

| JavaScript | Before | After | Reduction |
|---|---:|---:|---:|
| Initial graph, uncompressed | 10,809,198 | 7,981,668 | 26.2% |
| Initial graph, gzip | 3,379,494 | 2,511,084 | 25.7% |
| Initial graph, Brotli | 3,065,776 | 2,263,254 | 26.2% |
| Initial script requests | 11 | 11 | unchanged |
| Plain demo editor, cumulative uncompressed | 14,779,202 | 11,951,678 | 19.1% |

Chromium's decoded resource sizes agreed with the build's initial-byte totals in all eight runs. No optional
runtime was requested by the page before using its feature. The offline warm-up intentionally transfers their
source later when service workers are enabled: this is a reduction in critical download and evaluation work,
not a claim of eliminating that background transfer. Total emitted JavaScript remains approximately the same;
this change does not claim a measured end-to-end startup latency or playback-frame-rate improvement. Other large
eager code, including command registration, CodeMirror and the pure model, remains.

To reproduce the build measurements, save the baseline production `apps/web/dist` from `8b4c8936` in a separate
worktree before building the changed version. Run the measurement script from the changed checkout for both
outputs so both compression settings and accounting (including root worker scripts) match:

```sh
pnpm install --frozen-lockfile
pnpm --filter @jasper/web build
node scripts/measure-web-bundle.mjs /path/to/baseline/dist
node scripts/measure-web-bundle.mjs apps/web/dist
pnpm exec vitest run apps/web/test/polish-open.test.tsx apps/web/test/pwa.test.ts --maxWorkers=2
pnpm --filter @jasper/web typecheck
pnpm e2e:typecheck
pnpm e2e bundle-loading.spec.ts
```

Validation performed in this worktree: production web build, web and E2E typechecks, 16 focused unit tests, and
the browser download/offline suite. An authenticated running engine also exercised real QuickJS evaluation
(`time * 90` gives `90.09` at frame 30 of 30000/1001 fps), a DOM screenshot through `/api/agent/ui` (PNG 800×500),
and import/place/Program-preview of the repository's generated PDF and Lottie fixtures. The PDF canvas contained
painted pixels and the Lottie SVG was visible; the combined preview screenshot was inspected. These browser
checks had no page errors. Export code and the separate Remotion bundle are unchanged; no export speedup or new
render-fidelity claim is made. The root integration gate records the full repository and broader E2E checks.

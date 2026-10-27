# Performance hunt: defer the expression editor

Source inspection and the production bundle show that ordinary property controls
eagerly imported `ExpressionRow`, which imported `ExpressionField` and CodeMirror.
The initial generic vendor chunk therefore contained CodeMirror's editor,
JavaScript parser and autocomplete runtime even on Home and projects without
expressions. The earlier optional-runtime investigation left this dependency
eager because it required a component boundary rather than only a chunk rule.

`ExpressionRow` now uses the existing state-based `loadable` / `useLoaded` helper
to mount the unchanged expression controls when an expression row is visible.
CodeMirror and Lezer have a separate vendor chunk so that unrelated generic
vendor imports do not pull them back into startup. The pick-whip attribute stays
in the lightweight row helpers. The expression editor's text, completion,
keyboard, focus, commit and undo behavior are unchanged after it loads.

The first field now waits for an additional module download, showing the existing
Loading message meanwhile. A failed download leaves the surrounding property
controls and document available and offers Reload editor. A Chromium 153 probe
aborted an ES module request, restored the route, then imported the same URL
again: both imports failed and there was only one network request. A local retry
would therefore offer ineffective recovery; reloading creates a fresh module
map, following the editor shell's existing failure policy. No persistence or
editing API changed.

Offline first use is retained by including the expression editor and its static
import closure in the generated service-worker warm-up list. This runs after
window load and fetches the source without evaluating it in the page. Four new
chunks are emitted, including shared menu helpers split out of the entry; the
bounded asset cache grows by four entries and its version advances.

## Measurement

The baseline is `eb28696c`. Both builds used the frozen lockfile, Node 24.22.1,
pnpm 10.34.5, Linux x64, AMD EPYC-Genoa, eight logical CPUs and the same gzip /
Brotli settings. Source maps, CSS and fonts are excluded. Host load was
6.86 / 6.06 / 2.73 at the baseline measurement; the result JSON records the
after load. Byte counts do not depend on scheduler timing. Vite exhausted a
2 GiB and a 3 GiB V8 heap; both compared builds passed with a 5 GiB heap. Build
duration is not used as a performance result.

Measured bytes and chunk metadata are in
[`expression-loading.results.json`](../../apps/web/bench/expression-loading.results.json).
Initial JavaScript fell from 8,800,431 to 8,367,326 uncompressed bytes and from
2,775,279 to 2,630,046 gzip bytes (145,233 fewer gzip bytes, 5.23%). The initial
script count remains eleven. Total emitted JavaScript grows by 2,491 raw bytes.
Only the critical download/evaluation graph shrinks: total emitted JavaScript
changes slightly because of chunk boundaries. Background offline transfer is
approximately unchanged. No end-to-end startup latency, playback or export
speedup is claimed.

To reproduce, build baseline and current sources in separate worktrees and save
each `apps/web/dist`, then run the same measurement command for both directories:

```sh
pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=5120 pnpm --filter @jasper/web build
node scripts/measure-web-bundle.mjs /path/to/baseline/dist
node scripts/measure-web-bundle.mjs apps/web/dist
pnpm exec vitest run apps/web/test/expressions-ui.test.tsx apps/web/test/polish-panel-loading.test.tsx apps/web/test/polish-open.test.tsx apps/web/test/pwa.test.ts --maxWorkers=2
pnpm --filter @jasper/web typecheck
pnpm e2e:typecheck
pnpm e2e bundle-loading.spec.ts expressions.spec.ts pwa.spec.ts
```

The worktree passed its production build, full lint, web and E2E typechecks and
21 focused tests. The browser suite adds startup request-absence checks, an
aborted expression chunk with saved-document reload recovery, and the first
actual CodeMirror mount while offline. Its integrated execution and visual
inspection are recorded by the parent investigation; this note does not claim
those pending checks have already passed. No shader, media decoder or export
algorithm changed.

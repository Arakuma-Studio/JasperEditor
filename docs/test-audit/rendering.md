# Rendering test cleanup

Scope: all 87 assigned compositions test files, read with their renderer, audio, template or protocol owner and
relevant architecture/specification/work notes. [rendering.json](rendering.json) records each original named test
declaration (including parameterized templates) and the two surviving browser consolidation owners. It records
contract/source, credible failure, oracle, seam, refactor resistance, unique ownership, disposition and a reproduction
command. Reproduction commands are not claims that every opt-in suite was executed.

The ledger has 497 records: 448 KEEP, 13 DELETE, 8 REWRITE, 18 OPTIMIZE and 10 CONSOLIDATE. The consolidation records
comprise eight removed declarations and two surviving owners. There were 495 original declarations; 476 survive
including the two new owners. Runtime instances differ: the removed transition catalogue template instantiated
173 tests, while its 352 literal-endpoint/golden/feature tests remain.

Net test/support-code change: 302 added lines, 873 removed lines (**−571 LOC**). Four test files and the private
structure probe were removed; no committed snapshots or media fixtures were added.

## Changes and surviving ownership

- Remove private text paint planning/CSS/tile-copy checks. Exact stroke rings, inside/centre/outside placement,
  transparency, stacking and Gaussian shadows remain in the preview/export pixel witnesses in
  `text-paint.e2e.test.ts`. Remove its structure-inspection helper and six unused paint barrel exports; make
  `shadowKey` internal while retaining the module exports consumed by production text layers.
- Replace three lowered-preview array/tap-format tests with one Canvas 2D output case in the existing GL browser.
  Literal pixels prove translation, outside-box paint, reduced-resolution coordinates and shutter blur; an added
  asymmetric-padding/nonuniform-scale/rotation witness also checks the independent canvas coordinate map. The test
  reads no encoded tap offsets or production-derived expected maps.
- Replace five template definition/CSS checks with an actual Chromium gallery-card/warning-bounds witness in that
  same browser. It protects documented App QA N7/N8 without another browser launch. Pure framing/content-box
  helpers retain deterministic geometry contracts.
- Remove the transition catalogue's repeated no-error draws. Literal endpoints, three golden progress frames per
  transition, and family one-sided/reverse/pixel witnesses retain ownership.
- Remove two opt-in family wrappers (three scenarios): the shadow witness repeated the generic render test's same
  green pixel at x=440; the warp witness repeated generic padding wiring. The family GL suites retain exact shader
  shifts, outside paint and time behavior; `fx-render.e2e.test.ts` retains actual media/DOM-to-effect render wiring.
- Remove the asset success assertion that defaulted a missing report to `[]`, its sleep, and the face-gating test
  whose mock itself returned the asserted false value. Real asset rendering, deferred face/weight lifecycle,
  missing-asset reporting and named export failures remain.
- Keep dynamic asset/template names, typed reports and error classes while removing incidental English wording.
- Reuse one supported Remotion browser per text-paint/fx-render suite. Each render still uses its own page; teardown
  awaits browser closure and always closes fixture servers. Replace a MessagePort sleep with a FIFO sentinel,
  reuse immutable font-buffer input, and let the metadata-error fixture reach its arranged error directly.

No snapshots, committed media fixtures, dependencies or runner configuration became orphaned. Shared fixture
factories still have retained callers. Production changes only remove unused export visibility.

## Validation actually executed

All commands used Node 20.19.0, pnpm 10.34.5 and `--maxWorkers=2`; browser checks used Chromium
156.0.8078.47 through `JASPER_BROWSER_EXECUTABLE=/usr/bin/chromium-browser`. Oracle runs set
`JASPER_REQUIRE_ORACLES=1`.

- `pnpm exec biome check` on changed TypeScript/TSX and the ledger: passed.
- `pnpm --filter @jasper/compositions typecheck`: passed, including the final changes.
- `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts packages/compositions/test/mg-template-preview.test.tsx packages/compositions/test/template-assets-layer.test.tsx packages/compositions/test/template-marker-anchor.test.tsx packages/compositions/test/fonts-ready.test.tsx packages/compositions/test/social-comment-layer.test.tsx --maxWorkers=2`: 29 passed.
- `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=2 -t 'lowered text|the gallery card|absolute pass sizes|mipmapped outputs|lut media params'`: five passed; other cases intentionally filtered.
- `pnpm exec vitest run packages/compositions/test/transition-gl.test.ts --maxWorkers=2`: 352 passed.
- `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-paint.e2e.test.ts packages/compositions/test/fx-render.e2e.test.ts --maxWorkers=2`: 17 passed on the pristine branch and optimized branch; both also passed during the earlier diagnostic pair.
- After the final wording/fixture changes: `pnpm exec vitest run packages/compositions/test/anime-template-layer.test.tsx packages/compositions/test/template-assets-layer.test.tsx packages/compositions/test/template-media-layer.test.tsx packages/compositions/test/mg-host-remote.test.ts --maxWorkers=2`: 25 passed.
- Seven temporary mutations each failed at the intended assertion: clipped text paint padding, incorrect preview
  scale, omitted canvas drawing, lost shutter weighting, omitted gallery hint, warning at the canvas origin, and
  accepting a port from a different embedding window. Every mutation was restored. Both browser consolidation
  owners then passed again.
- Inspected generated `outside-export.png` and `fx-preview.png`: visible independent rings and the inverted
  stroke/shadow colors agree with the retained pixel witnesses. No goldens were re-blessed.
- `git diff --check`: passed.

The full required repository gate and remaining unchanged/opt-in rendering suites are the integration owner's
responsibility; they are not claimed as executed by this workstream.

## Measured performance and limits

Warm paired run, same machine/runner/worker/browser/oracle configuration, pristine commit `eb28696c` versus this
branch; two render files run together. Machine: shared x86_64 AMD EPYC-Genoa VM, eight vCPUs, 15 GiB RAM. A separate
JS validation lane remained active; per-run load averages were not sampled (post-run load: 12.25/8.17/6.81).

| Measurement | Before | After |
|---|---:|---:|
| Two-file command wall time | 69.57 s | 54.17 s |
| `fx-render.e2e.test.ts` test-file execution | 58.381 s | 39.614 s |
| `text-paint.e2e.test.ts` test-file execution | 52.439 s | 36.924 s |
| Metadata-error test execution | 1,011.63 ms | 2.72 ms |

Measured command wall saving: **15.40 s (22.14%)**. The file times overlap and must not be added. A preceding
optimized diagnostic run gave 40.02 s and 37.09 s for these files. No overall-suite or CI speedup is inferred from
this subset; the integration run measures the complete default suite separately.

`/usr/bin/time` reported user CPU 58.95→92.32 s and system CPU 31.62→32.29 s for the clean pair. These counters did
not improve. Browser subprocess accounting and shared-host conditions were not isolated; the original Remotion
path schedules browser closure asynchronously, whereas the reused browser is awaited at suite teardown. That may
affect accounting, but does not establish a cause for the difference. No CPU, memory or CI-cost reduction is claimed.
The immutable font fixture reduces explicit fixture allocations from ten 30 MiB buffers to one; process RSS was not
measured. Initial scratch jobs using a missing browser path and overlapping output names are excluded from the
paired figures above.

Expensive shader compilation/fingerprint suites, actual playback decoding and audio preview/export oracles remain:
they protect shader compilation freezes, catalog pixels, decoded source routing and sample/transport fidelity that
cheap plan or mock tests cannot prove. Their setup/compilation costs remain a bottleneck; no such behavior was
moved out of the existing gate.

## Asymmetric transform follow-up: validation pending

The existing lowered pixel case now additionally uses left 30/top 20 padding, anchor (32,18), position (48,18),
nonuniform scale (0.5,2), and clockwise 90° rotation. Its independent forward map before preview scaling is
`canvas(x,y) = (114−2y,22+0.5x)`: red source (36,32) reaches (50,40), and outside-box blue source (70,12) reaches
(90,57). Both full and half preview resolution check those literal colors and transparency at (116,40). Existing
translation, outside-paint and shutter assertions remain.

Using left padding in place of top padding for `fromLayer` changes this mapping by (+20,+10), so the red and blue
witnesses must fail. No tests, builds or mutations were run for this extension while the integration owner's
isolated baseline was active; its targeted test and this padding-axis mutation await integration validation.

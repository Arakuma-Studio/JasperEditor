# Motion-graphic browser harness repair

Recorded before editing from integrated head `2664ee01`. This repairs a cleanup regression in test support; no production behavior, test assertion or deadline changes.

## Observed failure and caller inventory

The full browser run failed `e2e/mg-clips.spec.ts` — `renderer-page protocol contract (Remotion 4.0.499) drives the fixture bundle frame by frame` after 38.2 seconds. Its trace shows bundle import returned HTTP 200 in 36.2 seconds, the sandbox HTML and bundle returned 200, and the subsequent `page.evaluate` threw `Cannot read properties of undefined (reading 'connectMgHost')` in 0.8 seconds. The injected IIFE contained `connectMgHost` but did not expose `window.MgHost`. No configure, seek, frame or sandbox assertion ran. The next UI workflow was skipped because the file is serial.

`packages/testkit/src/browser.ts` had lost both optional arguments during cleanup, while this E2E still called `bundleForBrowser(entry, {}, {globalName: 'MgHost'})`. A complete source caller search finds this sole nondefault consumer. Composition GL/Player tests and render scripts pass only the entry. The custom `define` injection has no surviving consumer and stays removed. The shared cleanup ledger's prior no-caller claim for `globalName` is corrected in place.

## Disposition and full retention bar

KEEP the existing renderer-page protocol case with unchanged assertions and deadlines; repair only its harness dependency:

1. Independent requirement: `docs/specs/08-motion-graphics-clips.md` MGC-021 explicitly requires a Playwright contract test against a fixture bundle for the pinned Remotion renderer-page protocol; `docs/security-review.md` MG-1 requires opaque-origin isolation and no engine/parent access.
2. Recognizable failure: imported compositions can stop showing the requested frame/props, ignore composition metadata overrides, or escape the preview sandbox. This case observes those failures in an actual loaded bundle.
3. Independent oracle: the requested title, 1280×720/30 fps override, authored fixture's known initial/settled frames, pinned protocol versions and prohibited parent/cookie/API access define expected outcomes. None is computed by `connectMgHost` or copied from its returned result to form the expectation.
4. Stable seam: the browser host's MessagePort adapter communicates with a real Remotion bundle; assertions observe renderer output, declared metadata and browser-enforced security boundaries. Fixture selectors identify the authored probe content.
5. Refactor tolerance: implementation factoring and MessagePort call counts may change while the visible frame/props, metadata and isolation contracts remain. No source grep, export inventory, mocked protocol reply or private call-count assertion is introduced.
6. Lowest stable owner: lower remote tests use controlled replies and lower engine tests inspect HTTP policy; neither verifies an actual pinned Remotion bundle running in an opaque-origin iframe. This remains the sole real browser protocol/sandbox owner, alongside the separate UI import/preview workflow.

The test's existing protocol JSON artifact and the UI workflow's screenshot remain intact. No wrapper unit test, replacement assertion, `define` hook or production-only seam is added.

## Minimal repair and validation

Implemented: accept optional second `{globalName?: string}` in `bundleForBrowser`, pass that option to esbuild, and remove the E2E call's obsolete empty `define` argument. Risk is limited to test bundling; default one-argument consumers retain the same build settings. Scoped Biome passed on both modified TypeScript files after formatting the call; TypeScript syntax parsing passed for both files; the reviewed diff passes `git diff --check`. These are static checks, not a typecheck or runtime protocol test. The observed full browser failure remains unresolved until the coordinator reruns the whole `mg-clips.spec.ts`; no runtime pass is claimed here.

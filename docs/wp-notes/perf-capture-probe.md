# HTML-in-Canvas capture regression probe

The performance work's baseline gate exposed an existing failure in
`packages/compositions/test/capture-safe-canvas.test.ts`. No production capture code changed.

In Chrome for Testing 153.0.8010.12, the original fixture's ordinary canvas positioned with
`left:100px` had a correct magenta backing pixel and the expected 100×100 visual box at x=100.
The containing `ElementImage` was correctly 200×100, but its captured right half was transparent.
The low-latency canvas at x=0 captured green. Both contexts reported `desynchronized:false`
after installing the shim. Explicit capture destination dimensions, CPU-backed contexts, root
display changes, and repeated paint requests did not restore the right half.

Positioning the ordinary control with `left:0;transform:translateX(100px)` preserves exactly the
same visual box and restores its magenta capture. The fixture now uses that positioning so its
two exact pixel assertions test late canvas draws independently of the observed absolute-inset
capture limitation. This is an observation of these browser probes, not a documented browser
guarantee. The API remains experimental; its API contract is described in the
[WICG HTML-in-Canvas explainer](https://github.com/WICG/html-in-canvas).

Chrome 153 also captures the low-latency canvas when the shim is omitted, although its context
reports `desynchronized:true`. The probe now additionally asserts both actual context attributes
are false. Removing the shim installation makes the updated test fail at that assertion; the
test therefore continues to detect loss of the shim's behavior on browsers that have fixed the
earlier low-latency capture problem. Both original exact pixel assertions remain.

Validation:

- Original test reproduced its transparent-right-half failure on Chrome 153.
- Updated test passed four runs with Chrome 153; also checked with ANGLE SwiftShader.
- Shim-off control failed with `expected true to be false`, then the shim was restored.
- `pnpm --filter @jasper/compositions typecheck` and targeted Biome checks passed.

Chrome for Testing 148.0.7778.178 was also probed. Its API methods exist, but it captured both
descendant canvases as transparent before and after this fixture change, including CPU-backed
and transformed variants. A DOM-only red background in the same capture worked. The updated test
still fails its exact green-pixel assertion on that binary; no assertion or capability check was
weakened to accept it. Chrome 153 is the browser used for the integrated gate. No general product
fix for either browser-specific capture limitation is claimed here.

Rerun against the selected browser:

```sh
JASPER_BROWSER_EXECUTABLE=/path/to/chrome pnpm exec vitest run packages/compositions/test/capture-safe-canvas.test.ts --maxWorkers=2
```

# Native and standalone platform tests

The [per-test ledger](native_standalone.json) records all 13 Rust tests, four
Electron clipboard cases, both desktop smoke modes, the native-capability fallback
script and the relocated-package LGPL export script: 21 audit records. Dispositions
are KEEP 16, REWRITE 4 and OPTIMIZE 1. No test, fixture, dependency, snapshot or
production API was deleted from this shard: each remaining owner has a documented
protocol, platform, security or historical-regression obligation that another layer
cannot prove.

The native acceptance test still renders all 150 frames with four real workers.
Its raster is now 64×36, replacing 384×216, which reduces emitted RGBA bytes from
49,766,400 to 1,382,400. All original progress, total-byte and alpha assertions remain.
The templates crate has no library unit tests (`#[test]` exists only in its `tests/`
integration directory); `lib.test = false` avoids linking/running that empty harness.
Its actual SVG integration test and documentation tests remain in the workspace run.

The desktop clipboard tests reuse two Electron processes, but every case now creates
a fresh destination project. Previously their shared document made the first case's
one-clip expectation depend on declaration order. Removing serial mode also stops
one failure from skipping unrelated clipboard contracts. The OS clipboard and
external Electron clipboard-owner helper remain real. Before leaving a case, the
next setup saves through Ctrl+S, waits for the visible saved state, then clicks the
Home button to navigate through the app router.

## Native measurements

Machine: Linux x86_64, 8 logical AMD EPYC-Genoa CPUs and 15 GiB RAM; Rust 1.99.1,
default optimized development profile, `cargo test --workspace --locked -j 1`.
Measurements exclude dependency download and compilation: both versions were built
first, received one warmup, then ran three times. Native runs held a dedicated
exclusive lock; JavaScript validation continued elsewhere on this shared host.

Before wall times were 0.4192, 0.4212 and 0.4170 seconds. After wall times were
0.3687, 0.4041 and 0.3677 seconds. The observed median fell from 0.4192 to 0.3687
seconds: 0.0505 seconds / 12.0%. Host load increased from 4.74–4.76 to 6.63;
these short measurements are indicative, not a controlled overall-suite or CI
speedup. Peak RSS remained approximately 120 MiB in both versions. The slowest
remaining native harness is the nine-case CLI integration file (one representative
run: 0.14 seconds before, 0.08 seconds after); individual-test timings were not
available from the stable Rust runner. Native tests are outside the default CI gate.
No timing claim is made for removing the empty harness's cold link work.

## Validation and limits

- Passed original and changed native workspace runs, each one warmup plus three
  measured repeats. All 13 tests passed with no ignored tests; no new flakiness was
  observed.
- Passed a deliberate regression check: changing real production progress reporting
  to finish at 149 made the optimized acceptance test fail its explicit final-progress
  assertion. Production source was restored and all 13 tests passed again.
- Passed scoped Biome checks and `git diff --check`.
- Native setup initially lacked Cargo, a C compiler and libclang. A local toolchain,
  build-essential and libclang-dev resolved those infrastructure failures. The first
  cold compile was interrupted to release the shared JavaScript-validation lock;
  the retry after the missing-libclang failure completed in 5m41s. Those cold stages
  are not before/after performance comparisons.
- The integrated desktop run passed the custom-format and image workflows but
  exposed setup failures for text/files: hard navigation triggered the correct
  dirty/saving unload guard. The setup now saves and uses the Home button; its
  browser rerun remains pending until the shared validation lane is available.
- Root integration passed both desktop smoke modes and the native-capability
  fallback check. Those are separate from the native measurements above.

Native command (local toolchain paths are environment setup, not repository pins):

```sh
CARGO_HOME=/tmp/jasper-rust-cargo RUSTUP_HOME=/tmp/jasper-rustup \
  /tmp/jasper-rust-cargo/bin/cargo test \
  --manifest-path native/mg/Cargo.toml --workspace --locked -j 1
```

The affected desktop runtime command is `pnpm e2e:desktop-clipboard`. The retained
standalone checks remain `node e2e/desktop-smoke.mjs packaged-like`,
`node e2e/desktop-smoke.mjs dev`, `pnpm e2e:mg-fallback` and `pnpm e2e:packaged`,
with their documented build prerequisites.

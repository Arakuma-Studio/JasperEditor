# Incoming font tests: second integration wave

Scope: every named declaration in `apps/engine/test/font-parser.test.ts`,
`font-library.test.ts`, `font-library.e2e.test.ts` and
`packages/api/test/font-resolve.test.ts`, plus their shared `font-fixtures.ts`.
These 38 declarations arrived in `2d364873..69c96e3b`; the integrated audit
checkpoint is `99d57175`. No original 5,722 declaration is counted again here.

Independent sources: [font work note](../wp-notes/fonts.md) (reader/bounds,
store/repair, resolution/routes and export-path contract; includes OpenType and
WOFF primary references), [architecture](../ARCHITECTURE.md) D-02/09/13 and
fonts/render boundaries, [project files](../project-files.md) font resolution,
and [security review](../security-review.md) AGT-3/authenticated routes.
AGENTS requires typed failures, bounded untrusted input, conservative persistence
and parser fuzzing. No proprietary font asset is added; generated original glyphs
and the existing openly licensed @fontsource packages remain.

For every surviving row below: the independent source specifies the named result;
its named wrong output/refusal/artifact is the recognizable regression. Oracles are
fixed fixture data, literal codes/metadata/URLs, independently named projects/files,
format invariants or decoded artifacts—not production constants or helper results.
The indicated public parser/resolver, storage, HTTP/WS or rendering boundary is
stable. Assertions observe results rather than private call ordering, reference
identity or implementation shape, so behavior-preserving internal refactors pass.
Each row identifies the input/transition/process boundary that remaining owners do
not cover. Shared facts apply to every explicitly named row, satisfying all six bars.

Disposition totals: **CONSOLIDATE 3**, **DELETE 1**, **KEEP 11**, **OPTIMIZE 3**, **REWRITE 20**. 34 default cases survive plus one opt-in rendering case (35 total); three redundant executions are removed.

## apps/engine/test/font-parser.test.ts

| Baseline test name | Disposition | Contract, oracle, unique failure and surviving owner |
| --- | --- | --- |
| reads a TrueType font: family, subfamily, full and PostScript names, weight, italic | REWRITE | OpenType name/OS/2 fields must become the literal Pixel12x10 metadata and unchanged file bytes. Byte equality replaces incidental reference identity; a copied return buffer remains valid. This is the basic sfnt metadata owner, not a store/route test. |
| prefers the typographic family / subfamily (name IDs 16 / 17) and keeps the legacy family as an alias | KEEP | OpenType name IDs 16/17 outrank 1/2 and retain the legacy alias: literal Circular Std / Medium / Circular Std Medium. Detects wrong family precedence that changes family menus and existing project resolution; other parser rows omit competing names. |
| reads italic from OS/2 fsSelection and bold weights | KEEP | OS/2 fsSelection and usWeightClass: literal 700 / italic / Italic. Detects lost style/weight bits; the basic generated face is normal 500 and cannot supersede this case. |
| reads WOFF (zlib tables) and WOFF2 (one brotli stream) wrappers of the same font identically | REWRITE | WOFF1 zlib and WOFF2 brotli must expose fixed Pixel12x10 metadata and retain identical bytes. Expected metadata is literal, no longer obtained by calling parseFont on the sfnt. Covers both container decoders absent from the plain sfnt owner. |
| reads real @fontsource files: WOFF2 with transformed glyf/loca, WOFF, and a variable font with axes | KEEP | Openly licensed shipped Montserrat/Lato/Inter files supply independently authored bytes and literal styles/weights/Inter wght 100…900, default 400. Detects incompatibility with real transformed glyph data or variable axes that generated null-transform wrappers miss. |
| splits a TrueType collection into standalone faces that parse on their own | REWRITE | TTC faces must become standalone sfnt files with literal Coll 400 and Coll 700 metadata when parsed independently. Reparse expectations now use authored values, not the first parse result. Detects bad table rebasing or extraction; installation checks alone cannot establish parseable returned artifacts. |
| reads CFF-flavoured OpenType (OTTO) as otf | KEEP | OTTO/CFF flavor must produce otf / Cff Test. Detects classifying accepted CFF-flavored bytes as TrueType or rejecting the supported flavor; no other parser success uses OTTO. |
| sniffs containers from the signature | DELETE | Fails unique protection and stable-seam bars: a signature-dispatch helper had no caller outside its own parser. Public parseFont format/refusal cases already verify every supported container. Remove the test and make sniffFontContainer private. |
| refuses non-font bytes, empty input and PostScript Type 1 | KEEP | The font import contract refuses empty/non-font bytes as FONT_INVALID and Type 1 as FONT_UNSUPPORTED. Literal codes distinguish unsupported from damaged input; required-table cases start with recognized sfnt signatures and do not cover dispatch. |
| refuses fonts without names, outlines, a character map or a valid head | REWRITE | A recognized sfnt missing required naming/cmap/outlines/head data or holding bad head magic is FONT_INVALID. Replace an incidental English word pin with the stable code. Individually altered valid tables make unrelated refusals unlikely; signature cases do not cover structural validity. |
| refuses tables that point outside the file and truncated files | KEEP | Out-of-file table extents and truncated headers/bodies must be FONT_INVALID. Literal code at parseFont catches unsafe reads or acceptance; missing-table fixtures are complete containers, so do not own extent checking. |
| refuses WOFF2 / WOFF collections with a clear message | REWRITE | WOFF/WOFF2 ttcf flavor is unsupported, not corrupt: literal FONT_UNSUPPORTED for each container. Drop English message spelling. TTC success must remain supported, so the plain collection owner cannot replace these format-specific refusals. |
| refuses files over the size cap before reading them | REWRITE | The independently documented 64 MiB file cap is pinned with literal 64 MiB + 1 input and FONT_TOO_LARGE, rather than allocating relative to the production constant. Detects silently increased/removed cap; HTTP preflight is a separate boundary and never invokes this parser with the oversized bytes. |
| refuses decompression bombs: a WOFF2 stream larger than its directory declares | REWRITE | [WOFF2 §5](https://www.w3.org/TR/WOFF2/) independently requires the decoded block size to equal the directory lengths. Keep the actual valid font-table payload and append one surplus byte; the only invalidity is this length mismatch. The former zero-filled payload still failed on invalid font metadata after both length protections were removed, so it was a false-positive refusal. The corrected case fails that real mutant. This is wire-format validation, not an allocation-safety claim; WOFF1 uses a different decoder. |
| refuses a WOFF table that inflates past its declared length | REWRITE | [WOFF1 §5](https://www.w3.org/TR/WOFF/) requires a decoded table to match origLength. A zlib-compressed WOFF name table expanding beyond its declared length must be FONT_INVALID. Remove non-contract English zlib/declared words while keeping a fixture assertion that the chosen table really is compressed. Distinct from WOFF2 brotli and sfnt extent checks. |
| random bytes, with and without a font signature | REWRITE | AGENTS requires parser fuzzing: 1500 arbitrary/signature-prefixed byte arrays yield either structurally valid bounded faces or FontParseError. Independent bounds are literal name≤128 and weight 1…1000 instead of reading the implementation limit. Detects unexpected parser exceptions at a public boundary; valid-font mutation fuzz cannot cover arbitrary signatures. |
| valid fonts of every container with flipped bytes and truncations | REWRITE | AGENTS parser fuzzing: 1500 flipped/truncated valid fonts across four containers retain the same typed-refusal/valid-face invariant with literal name bound. Detects deep directory/name/stream crashes unreachable with purely random headers. Existing per-input timing remains; no sample count was reduced. |
| huge declared counts and lengths are refused without large allocations | REWRITE | AGENTS bounded untrusted allocations: 600 huge header/count mutations across supported containers must yield valid bounded faces or FontParseError without array-buffer growth above the documented 128 MiB plus 1 MiB allowance. Pin literal budget; rename a misleading unconditional-refusal claim because a mutation can land in an unused field. This property observes allocations and results rather than private guard calls; heap sampling is not a complete process-peak guarantee. |

## apps/engine/test/font-library.test.ts

| Baseline test name | Disposition | Contract, oracle, unique failure and surviving owner |
| --- | --- | --- |
| installs, lists, persists across reopen; same bytes again are "existing"; collections split into faces | REWRITE | wp-fonts store contract: actual bytes install once, TTC faces persist across reopen, remove survives reopen, revisions advance. Literal full names replace comparing one implementation result to another. Remove duplicate notification and fixed-clock assertions; HTTP owner verifies actual fonts.changed. Unique lowest storage/reopen boundary; route restart uses one face, not split collections. |
| refuses bad bytes, oversized files, a full library and a different face with an installed PostScript name | REWRITE | wp-fonts refuses a different file with an existing PostScript name, more than 1,000 faces, and more than 2 GiB. Exercise actual limits using real, SHA256-consistent persisted font files; sparse valid sfnt padding avoids writing/allocating 2 GiB. Separate 1,000-small-face and 32 × 64 MiB states isolate the guards. Refusal must be 409/FONT_LIBRARY_FULL and leave index/files unchanged. Remove test-only clock/limit injection and duplicate parser/HTTP invalid-input assertions. Both actual guards have independent failing mutants. |
| accepts WOFF and WOFF2 and keeps them as they are | REWRITE | WOFF and WOFF2 installs retain literal format and exact authored on-disk bytes. Replace extension/getter/path-shape checks with artifact equality. Parser cannot establish persistence; HTTP bytes currently own the TrueType path only. Public store output survives helper/layout refactors that preserve the storage contract. |
| an unreadable index is kept aside and rebuilt from the font files | REWRITE | Unreadable-index recovery must preserve the exact damaged original in the documented corrupt backup and recover both literal face names with visible repair reporting, then reopen cleanly. Drop English sentence pins. This uniquely protects corruption recovery; stray-file and missing-entry tests start with readable indexes. |
| an entry whose file is missing is dropped; a stray face file is adopted; temp files are removed | OPTIMIZE | Crash-mid-remove/install recovery drops the missing face, adopts the independently SHA256-named real stray file, removes owned temp files and preserves unrelated notes. Construct the stray artifact directly instead of creating a second library/install transaction. Literal families and affected-font repair data own this crash state; ordinary install/reopen never simulates interruption. |
| entries that no longer validate are kept aside, never silently dropped; a damaged face file is dropped | REWRITE | Malformed index entries remain in invalid; damaged face data is dropped and reported by its family. Literal invalid object and surviving ID protect conservative repair; remove incidental English damaged wording. Distinct readable-index corruption from missing/stray files and complete unreadable-index backup. |
| an index written by a newer build is listed but never rewritten (read-only) | KEEP | A future-version index is readable, installation/removal fail FONT_LIBRARY_READ_ONLY, and its exact bytes/future field remain unchanged. Independent compatibility policy in AGENTS/wp-fonts; detects destructive downgrade. Ordinary reopen and malformed-index repair require writes and cannot own this guarantee. |
| upload → list → catalog → served file; events; restart keeps it | REWRITE | HTTP upload/list/catalog/file/events/restart must expose the installed face, byte-exact immutable TTF URL, revision event only on change, correct catalog and post-restart availability. Limits now have independent literal 64 MiB/1,000/2 GiB expectations. Preserve route path refusals. This owns HTTP/schema/event wiring; store tests do not mount routes or catalog. |
| refuses bad bytes (400), unsupported kinds (415), oversized bodies (413) and JSON bodies (415) | OPTIMIZE | HTTP maps invalid/unsupported/oversized/content-type/schema requests to 400/FONT_INVALID, 415/FONT_UNSUPPORTED, 413/FONT_TOO_LARGE and 415 as specified, leaving the library empty. The original huge buffer only reached content-length preflight; send an oversized content-length declaration with a tiny body instead of allocating 64 MiB. Actual running-stream cap is not newly claimed covered. Distinct wire mapping from parser refusal. |
| requires the engine token on every font library route; signed URLs serve the files to renderers | KEEP | AGENTS/security-review auth: every font-library endpoint refuses missing token 401; the stored file also requires auth and a legitimate signed URL serves it 200. Literal statuses and actual signed request detect accidentally unauthenticated font routes; positive route cases cannot establish denial. Existing authenticated upload proves the route exists. |
| installs from an absolute local path (relative, missing and directory paths are refused) | REWRITE | Absolute local file install succeeds with literal family/original filename; relative, missing and directory inputs have exact status+error-code pairs. Add reason assertions so an unrelated error cannot satisfy the negatives. Owns path endpoint validation, distinct from bytes upload. |
| usage lists the saved projects whose fonts resolve to the face | KEEP | Saved-project usage finds both authored family and PostScript references, excludes Inter, and reports scanned 3/truncated false. Literal project IDs are fixture outputs, not inferred by the implementation. Detects an incomplete resolution/usage scan; generic resolver lacks persisted projects and approval tests only one family. |
| an agent removing a font needs the user (the card names projects that use it); the editor does not | OPTIMIZE | AGENTS AGT-3: agent deletion with no editor/denial retains the font, approval removes it, card names the affected family/project, editor-origin deletion succeeds without a new card. Real public WS welcome replaces 100 ms sleep; remove non-contract label wording and excessive 120 s group timeout. Unique font-route approval wiring; generic approval machinery cannot prove this endpoint requests it. |
| a missing font keeps the fallback and is named; installing it later makes the same project use it | CONSOLIDATE | Surviving planner owner now covers absent→install→remove for the same mixed-font document. Literal fallback URLs/codes/missing-family data and installed PostScript URL prove live catalog invalidation; remove sentence/order pins and private filePath suffix assertion. Owns actual export snapshot resolution; generic resolver cannot establish planner wiring. Includes the removed duplicate removal case. |
| removing the font brings the fallback back | CONSOLIDATE | Duplicate fresh-app upload→plan→delete→plan execution moved into the existing missing/install planner scenario. That surviving owner still checks FONT_FALLBACK after removing the installed CircularStd-Medium face while Pixel12x10 remains installed, so both invalidation directions remain protected. |

## packages/api/test/font-resolve.test.ts

| Baseline test name | Disposition | Contract, oracle, unique failure and surviving owner |
| --- | --- | --- |
| matches families exactly (case-insensitive), bundled first, latin subset, nearest weight, italic when present | KEEP | wp-fonts resolution priority: literal URLs prove bundled-first exact family match, latin subset, nearest weight, italic selection and normal fallback when no italic exists. Direct public shared resolver is the lowest stable owner; parser/store/renderer tests do not cover this disambiguating catalog. |
| matches families loosely, then a face by PostScript, full or legacy family name (that face, any weight) | REWRITE | wp-fonts loose family then PostScript/full/legacy face resolution chooses literal URLs independently of requested weight; add underscore/case/space variation from the deleted helper owner. Result-based shared public API accepts internal matching refactors; avoids duplicate helper normalization contract. Exact-family owner lacks aliases. |
| returns null for unknown or empty names and without a catalog | KEEP | Unknown/blank names and absent catalog return literal null instead of selecting an unrelated font or throwing. Shared resolver public failure contract; success rows cannot detect bogus fallback results. |
| normalizes names by case, spaces, hyphens and underscores | CONSOLIDATE | Exact normalized helper string has no independently public obligation or non-test caller outside its module. Preserve the meaningful underscore/case/space matching assertion at resolveCatalogFont; make normalizeFontName private. The surviving loose resolver owner covers externally visible behavior without freezing helper representation. |

## apps/engine/test/font-library.e2e.test.ts

| Baseline test name | Disposition | Contract, oracle, unique failure and surviving owner |
| --- | --- | --- |
| a Pixel12x10 title renders with the installed font in the preview, the native and Remotion exports and stills | REWRITE (also optimize) | AGENTS export fidelity/wp-fonts: actual installed font must render consistently through Program composition, auto hybrid, forced Remotion and still route (≥99% bytes within 3/255), each visibly distinct from a controlled pre-install fallback (>2,000 changed reference pixels, ≥80% of that for outputs). A visible Source Sans 3 styled-run control keeps the fallback face identical before/after; a real library-font-load failure now makes contrast zero instead of passing by changing to Arial. Original generated glyphs and decoded artifacts provide the independent oracle. Static first-frame duration 1 replaces 30 equivalent frames without changing 720p/120px glyphs, codec or bounds. Output-level parity resists renderer refactors; lower resolvers cannot establish Chromium font acceptance and every actual export route. Two restored optimized runs pass; all five decoded pictures exactly match the controlled 30-frame baseline. |

## Removed infrastructure and production seams

The only non-test caller of `sniffFontContainer` is `parseFont`; the only non-test
caller of `normalizeFontName` is its same-file public resolver. Both helpers become
private after their redundant direct tests disappear. Production consumers keep
`parseFont` and `resolveCatalogFont` unchanged. `FontLibrary.open` production usage
in `tools/services.ts` supplies only `onChange` and `log`; remove unused `now` and
`limits` injection options, their limits type and the clock-forwarding method.
The production default date and 64 MiB/1,000/2 GiB behavior remain the same.
Remove the unused fixture `padBytes` option/table; `glyphRects` now creates cheap,
valid blank fonts for real capacity states. No dependency/configuration changes. Net test/support change: +9 lines; production source: −9 lines. The extra real-cap fixture replaces unsafe test-only limit overrides; the repository-wide cleanup remains strongly net-negative.

The actual-cap fixtures have consistent font bytes, SHA256 IDs, sizes and names.
The 1,000-face fixture stays far below 2 GiB; the 32-file byte fixture stays below 1,000
faces. Its 64 MiB sfnt files use valid trailing zero padding, hashed in a reused 1 MiB
buffer and represented as sparse files. They require roughly 1.6 s of test-body work
instead of 1,000 atomic install transactions or allocating/writing 2 GiB. Both refusal
paths preserve the exact pre-existing index and file count. Disabling either real
production guard independently makes its install resolve and the test fail.

## Validation and measurements

The unmodified integrated root baseline (`99d57175`) ran all 60 incoming changed
files before this work: all 37 default font cases passed; the rendering case was
explicitly skipped. The five failures belonged to other easing imports, not fonts.
Raw baseline: `/tmp/jasper-test-cleanup/incoming-wave2/baseline.{json,log,time}`.

Actual Node 20.19.0 / pnpm 10.34.5 / Vitest 4.1.11 checks in the owned worktree:

```sh
env -u NODE_OPTIONS JASPER_REQUIRE_ORACLES=1 pnpm exec vitest run \
  apps/engine/test/font-library.test.ts apps/engine/test/font-parser.test.ts \
  packages/api/test/font-resolve.test.ts --maxWorkers=2 \
  --reporter=default --reporter=json --outputFile.json=<evidence>.json
env NODE_OPTIONS=--max-old-space-size=4096 \
  pnpm --filter @jasper/api --filter @jasper/engine typecheck
env -u NODE_OPTIONS pnpm exec biome check \
  apps/engine/src/fonts/library.ts apps/engine/src/fonts/sfnt.ts \
  packages/api/src/fonts.ts apps/engine/test/font-fixtures.ts \
  apps/engine/test/font-library.test.ts apps/engine/test/font-parser.test.ts \
  packages/api/test/font-resolve.test.ts
git diff --check
```

All three post-cleanup runs passed 34/34 cases. The final source passed in 17.82 s
Vitest time; previous post runs took 23.50 s and 19.87 s (shared-host startup/import
variance). API plus engine actual TypeScript passed in 48.68 s with the documented
four-GiB heap allowance; Biome checked all seven changed code files without fixes.
No test was skipped by the default target. Worktree dependency links resolve its
own API/project/composition sources, not another checkout's implementation.

Three intended production mutations failed: removing the real face-count guard
and removing the real total-byte guard each caused the expected refusal promise
to resolve; ignoring typographic family ID 16 yielded Circular Std Medium where
the literal expected family was Circular Std. Sources were restored in `finally`;
both subsequent full targets passed. Logs and mutation script/results are under
`/tmp/jasper-test-cleanup/wave2-fonts/`.

Measured case costs: the old injected-limit case took 58.8 ms in the integrated
baseline; real-cap protection took 1,563 ms initially and 1,501 ms finally. This
approximately 1.44 s body increase is deliberate stronger production-cap coverage,
not claimed as a performance win. The initial parser file span fell from 599.8 to 410 ms, but the reduced all-zero
WOFF2 fixture subsequently proved a false positive and was replaced, as below. Its
36.5 ms timing is historical evidence for that discarded fixture, not a claim of
valid optimized regression protection. The whole three-file baseline was part of a
larger 60-file run, so no comparable process-wall or CI speedup is inferred.
No concurrency, fuzz sample count, meaningful assertion or tolerance was weakened.

The default baseline records the optional renderer test skipped. Its separate actual
rendering execution and final oracle correction are recorded below; no skipped
oracle counts as success.

### Corrected WOFF2 oracle and independent protocol evidence

The final review tested the claimed refusal rather than trusting the green result.
Removing both the actual brotli output bound and decoded-length check left the old
all-zero WOFF2 case green (one selected case, 414 ms runner): unrelated invalid
head/name bytes still yielded `FONT_INVALID`. It did not establish its claimed
length regression and is not retained in that form.

[WOFF2 §5](https://www.w3.org/TR/WOFF2/) requires the decoded data-block size to
match the summed directory lengths. The corrected fixture decompresses its valid
generated WOFF2 payload, appends exactly one surplus byte, recompresses it and
updates only the compressed/file lengths. Every actual font table stays valid.
The same real production mutant then fails with `expected a refusal`, because
`parseFont` now wrongly accepts the container. Neither test checks private calls
or demands a particular guard implementation; any implementation that correctly
refuses the malformed wire format passes.

[WOFF1 §5](https://www.w3.org/TR/WOFF/) independently requires decoded table size
to equal `origLength`. Its existing genuine compressed name bytes plus shortened
directory length already had this property: removing its output bound and exact
length check caused `expected a refusal` (396 ms runner). It needs no replacement
fixture. Neither case claims to measure peak allocations or independently prove
the decompressor's per-call memory budget. The separate large-header fuzz owner
retains its explicit observed-allocation bound and limitations.

Restored source passed all 17 parser cases in 833 ms runner / 389 ms bodies.
Actual engine TypeScript passed again with the four-GiB heap allowance;
Biome and diff checks passed for the final source. No production behavior changed
in this followup. Raw logs/scripts/results:
`/tmp/jasper-test-cleanup/wave2-fonts/{length-*,mutant-length-*}`.

### Actual font rendering: correct the identity oracle, then remove repeated frames

The original opt-in owner was green but had a second false positive: disabling
registration only for `/fonts/library/` faces left catalog/planner metadata correct
and all pixel-parity/contrast assertions passed. Before installation the output
used Source Sans 3; after a failed library load it silently used Arial. Different
fallback glyphs satisfied the difference witness (24,782 pixels), while all paths
agreed on the same wrong face. That old green run is not valid regression evidence.

The existing case now renders its final character explicitly in Source Sans 3 via
the public text styled-run contract. This visible control loads the declared
fallback family on every path. A failed library font therefore renders exactly
like the pre-install fallback, rather than choosing a different available face.
The same real production mutation now fails the intended identity assertion:
**0 changed pixels, required >2,000**. There is no private FontFace-call assertion,
production injection hook, extra test or widened bound. Production source was
restored in `finally`, and actual runtime sourcemaps prove both normal and mutant
bundles contain the exact owned composition source.

The fixture is static: no animation, keyframe, transition or time-dependent content.
Once the oracle was corrected, a fresh 30-frame/frame15 baseline ran before shortening
the movie to one frame and sampling frame0. The 720p resolution, 120px glyphs, ProRes
settings, 99% within 3/255 parity, >2,000 reference difference and 80% delivered
contrast bounds are unchanged. The required three exported movies have actual
`ffprobe` frame counts 30→1. All **five** decoded pictures—fallback, Program
composition, native, forced Remotion and still—are byte-identical between the
controlled 30-frame baseline and **both** single-frame runs (maximum RGB byte
difference 0). Valid reference contrast is 36,739 pixels in all three runs. The
Program reference and extracted native PNG were inspected visually: original block
glyphs, the visible fallback control, full frame and background render correctly.

Comparable quiet single-file measurements (same Node 20.19, pnpm 10.34.5,
Vitest 4.1.11, worker cap 2, Chrome 156, required oracles, unchanged system decoder and
root's verified LGPL render binaries; owned fresh engine/temp/bundle per run):

| Controlled fixture | Command wall | Vitest | Case body | Result |
| --- | ---: | ---: | ---: | --- |
| 30 frames, frame15 baseline | 44.81 s | 43.60 s | 23.121 s | 1/1 pass |
| 1 frame, frame0 first run | 39.00 s | 37.77 s | 16.886 s | 1/1 pass |
| 1 frame, frame0 restored repeat | 42.49 s | 41.26 s | 20.514 s | 1/1 pass |

Final-repeat wall saving: **2.32 s / 5.18%** versus the controlled baseline. The
first optimized run was faster still, but the 3.49 s difference between optimized
samples shows material variance; no universal CI saving is inferred from these
samples. Cold application imports remain roughly 19–20 s. The earlier unguarded original/single-frame runs are archived as failed-oracle
discovery and are excluded from this performance comparison. Every positive render reported 100.000%
of native/Remotion/still bytes within 3/255 of the preview.

Actual command (run separately for each source version, with short owned `TMPDIR`
and an external evidence collector before normal temp teardown):

```sh
env -u NODE_OPTIONS REMOTION_E2E=1 JASPER_REQUIRE_ORACLES=1 \
  JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  pnpm exec vitest run apps/engine/test/font-library.e2e.test.ts \
  --maxWorkers=2 --reporter=default --reporter=json \
  --outputFile.json=<run>/run.json
```

Actual engine TypeScript passed again with the four-GiB heap (33.49 s), as did
changed-file Biome and diff checks. One initial diagnostic mutant attempt used a
long external temp-path label and Chrome failed its Unix socket-path limit before
rendering; this is explicitly **not** a caught font regression. Shortening only
the evidence-run label allowed the real mutant evaluation. An optional Pillow
artifact-analysis import was unavailable; existing FFmpeg/ffprobe oracles performed
all extraction, frame-count and byte comparisons instead, without adding a dependency.

Evidence: `/tmp/jasper-test-cleanup/wave2-fonts/optin/` includes source/alias proofs,
per-run logs/JSON/GNU time, copied actual movies/PNGs, source-map hashes,
`comparison.json`, `performance.json`, and external runner/analyzer scripts in the
parent directory. Generated media remain ignored and are not committed.

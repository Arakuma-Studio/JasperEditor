# Audit counting basis

Recorded before the documentation-only counting correction against `abdad753`.
This correction labels the existing counting units; it changes no disposition,
test, production code, validation result or runtime deadline.

The reconciled discovery inventory contains **4,451 original named TypeScript /
JavaScript test declarations** in the 623 assigned test/spec paths. The assignment
inventory also includes four Rust paths, for **627 assigned paths** across the
19 area ledgers. Dynamic families, Rust declarations, standalone executable
scenarios and benchmark gates were inspected separately where named-test
discovery does not enumerate them. The 4,451 figure is an inventory count, not a
runtime case count or a sum of every decision row in the reports.

| Area ledger | Original named inventory | Additional counting basis in the ledger |
| --- | ---: | --- |
| project1 | 393 | 395 decision rows include two dynamic transition families. |
| project2 | 419 | 419 original declarations/families; the OCIO transfer is counted here once. |
| project3 | 373 | 409 decision rows include 35 fuzz targets and one dynamic roll family. The separately named `$name` slide family is already in the 373. |
| project4 | 378 | 378 originals; the seven Lumetri transfers are REWRITE here once. |
| engine1 | 221 | 232 decision rows include 11 explicitly named fuzz targets. |
| engine2 | 201 | 201 named declarations; HTTP fuzz families are covered separately. |
| engine3 | 226 | 227 rows include the dynamic processing-step family. The recipe/range template declaration is already in the 226. |
| web1 | 192 | 192 original named declarations. The guide-preference correction rewrites an existing row. |
| web2 | 236 | 236 original named declarations. |
| web3 | 218 | 218 original named declarations. |
| compositions1 | 255 | 259 original decision rows include four dynamic gallery declarations. |
| compositions2 | 257 | 257 named original rows; the dynamic wipe-gallery deletion is documented separately. Transferred project contracts are counted by their original owner. |
| e2e1 | 110 | 110 original declarations, representing 111 expanded original cases. |
| e2e2 | 123 | 123 originals; 23 REWRITE rows are consolidated into 16 workflows. |
| mcp | 163 | 163 original named declarations. |
| audio | 265 | 265 originals; per-effect and per-signal parameter expansions do not add originals. |
| formats | 159 | 163 decision rows include four fuzz families. |
| shared | 160 | 160 originals, plus a separately retained generated PNG fuzz target. |
| tooling | 102 | 120 initial decision rows comprise these 102, 14 Rust declarations, and four desktop clipboard declarations outside the test/spec filename pattern. Other executable scenarios and benchmark gates are separate. |
| **Total named inventory** | **4,451** | **Do not add the heterogeneous decision-row counts to this denominator.** |

The original names, paths and six-bar records remain the disposition authority.
Later explicitly superseding records take precedence over earlier headings and
historical subtotals. For example, the composition oracle rescan rewrites the
original Show Mask case, and the tooling rescan rewrites five formerly KEEP
declarations. Counting both the initial row and its supplement would duplicate
the same original. Because the ledgers mix these counting units and preserve
superseded records, this review does **not** claim an exact global DELETE /
REWRITE / KEEP subtotal by summing their headlines.

Four new regression declarations are outside the original census: two Remotion
selection-error cases, one rsync symlink-upload case, and one MCP window-metadata
case. The camera-oracle support move, shader case transfers and parameterized
splits are not additional original declarations. The WER helper self-test deletion
is counted once by engine1; engine3's supplement records implementation evidence.

Validation for this correction is a read-only inventory/ledger reconciliation,
documentation diff review and `git diff --check`. No tests, typechecks, builds,
browser jobs or benchmarks were run for the counting correction. Current runtime
results and limits remain in the audit index and their owning evidence records.

# perf-core: editing-core performance (ARCHITECTURE §13 budgets)

Scope: make one command on a 1 000-clip sequence (< 4 ms) and a 50-clip gesture update (< 8 ms) meet the §13
budgets, with incremental invariants proven equal to the full check, and fix the other hot spots of the
transaction pipeline. No behaviour change: every document, result, warning and refusal is what it was.

Builds on golden-fuzz's work (proxy-free `peek` reads, the per-sequence invariant memo, the expression memo, shape
re-centring of named clips, the stale-draft index fix, the scale benchmark), which is kept: the per-sequence memo
still speeds up every full check (the fallback path and the `verify` mode).

## 1. Where the time went (profiled)

`packages/session/bench/editing-core.ts` (`PROFILE=<dir>` writes CPU profiles of the timed sections only), 1 000
solid clips on four tracks, this host (12-core EPYC, Node 20, shared, load 15–25):

| Step | Command (param.set) | 50-clip gesture update |
|---|---|---|
| Before | 31 ms | 144 ms |
| full `checkInvariants` | ≈ 60 % | not run (prod gestures skip it) |
| Immer drafting by whole-sequence scans through proxies (`clearRange` → `trackClips` once per moved clip, `cleanupSequence`, `collectOrphans`, caption ownership, shape centring, clip lookup) | ≈ 30 % | ≈ 95 % |
| zod validation of the commands, diff, history entry, session state | < 5 % | < 5 % |

History already shared structure (entries hold the before/after documents; undo is a pointer swap, 0.3 ms);
gesture updates already re-applied to the base document (no whole-document clone per frame). The render snapshot
(1.2 ms per sequence on the 5 000-clip project) and autosave serialisation (≈ 100 ms for 8 MB JSON, debounced)
were measured by the scale benchmark and left as they are (§6).

## 2. Incremental invariants (`packages/project/src/invariants-incremental.ts`)

`checkTransactionInvariants(base, next, opts, mode)` replaces the full check in `applyTransaction`. It returns
exactly `checkInvariants(next)`: when the incremental check finds a problem (or cannot decide) the full check
produces the issue list, so only the "valid" verdict is incremental.

- **Shared code.** `checkInvariants` was split into `invariantCheckers` (per clip, link, group, transitions, track
  mattes, overlaps; the code moved verbatim) and `runInvariants` (the full walk, also returning every claimed id).
  Full and incremental checks run the same per-entity code.
- **Verified documents.** A document that passed a check is recorded (WeakMap) with an **id index** of every id it
  claims (INV-001), layered (each transaction adds a small added/removed overlay; flattened past 48 layers).
- **What is re-checked** when the base is verified, the document-level records are unchanged (synthetics may
  come and go) and no sequence was added or removed: per-clip invariants of new and changed clips; ids claimed by
  changed entities against their old claims and the index; overlaps on the tracks a clip arrived on, moved on or
  changed length on; links and groups that changed or that a changed clip names, and the clips they list; all
  transitions of a changed sequence; track-matte graphs when a matte effect is involved; nesting cycles when a nest
  clip changed; INV-014 for references a clip gave up (counted over the document); synthetics added, removed or
  changed (kind changes fall back); expressions, Essential Sound (remix groups on the whole sequence), colour and
  mixer checks on the changed clips.
- **Fallbacks to the full check** (counted, with the reason, in `invariantStats()`): unverified base (first edit
  after open), document-level fields (items, media, transcripts, fonts, settings…), sequence-level fields (tracks,
  settings, master, multicam…), sequences added or removed, caption transcripts, a nested sequence whose duration
  changed, a reference given up, a synthetic's kind.
- **Modes.** `incremental` (production), `full`, `verify` (the full check decides; the incremental one must agree on
  validity *and* on the id index, else the transaction fails with `E_INTERNAL`). Tests (Vitest) default to
  `verify`, so the whole suite (2 000-run AC-25 fuzz, every command test) cross-checks; dev engines (`JASPER_DEV`)
  and dev web builds (`import.meta.env.DEV`) set `verify`; `JASPER_INVARIANTS=full|incremental|verify` overrides;
  `ctx.invariants` per transaction; `setInvariantMode()`.

## 3. Proxy-free and delta-scoped scans (`packages/project/src/commands/draft-read.ts`, `tx-delta.ts`)

- `latest(draft)` reads the object a draft currently reads from (Immer's `copy_ ?? base_` behind
  `Symbol.for('immer-state')`), so scans create no drafts; golden-fuzz's `peek` now goes through it. A load-time
  probe checks Immer's state shape; if it ever changes, reads fall back to the public `current()` and
  `test/draft-read.test.ts` fails.
- `recordDelta(draftRecord)`: the keys a transaction changed so far, from Immer's bookkeeping (`assigned_`, the
  scope's written child drafts) in O(changes), probed at load and fuzz-checked against an identity scan.
- Results of a transaction are marked **normalized** (orphan-free, caption ownership normalized) and their
  sequences **clean** (verified). On such a base the end-of-transaction normalizers look only at the delta:
  `collectOrphans` counts the uses of given-up references and new entities (per-record use counts of the base
  plus the changed clips), caption ownership is skipped unless a captions clip or transcript changed,
  `cleanupSequence` visits the changed links/groups/clips and the members of removed groups. `setDeltaScans(false)`
  turns all of this off; tests prove equal documents, results and warnings.
- `clip.move` overwrite: one candidate search for all destination tracks (binary search on the clean base's sorted
  per-track index plus the delta) instead of a full scan per moved clip; `findTrackIn`, clip lookup (indexed after
  eight lookups in a transaction) and `idExists` read without drafting.
- Shared memoized key diff (`keyDiff`) for the entity diff, the invariants and the text-animation warnings; the
  per-track index (`derive/index.ts`) of a new sequence version is derived from the previous one (only tracks of
  changed clips rebuilt, merge instead of sort; §13: "indexes rebuilt only for tracks in `changed`").

## 4. Usage

- `pnpm exec tsx packages/session/bench/editing-core.ts [clips] [sequences] [runs]` (`PROFILE=dir` for profiles):
  command, gesture update, gesture commit and undo, plus the invariant path counters.
- `pnpm exec tsx apps/web/bench/timeline-gesture.ts`: the TimelineController's pointer move of a 50-clip drag plus
  the panel's derivations of the drawn sequence.
- `pnpm exec tsx packages/session/bench/scale.ts` (golden-fuzz): 200 sequences / 5 000 clips.
- `GET /api/perf` → `invariants: {mode, incremental, full, fallbacks}`; the editor's `perf` UI action and MCP
  `perf_stats` report the same for the open editor.

## 5. Verified behaviour (tests)

- `packages/project/test/invariants-incremental.test.ts`: 300 random chains (3 000 with `FUZZ=1`) of real commands
  and 35 kinds of corruption (overlaps, id collisions with every entity kind, malformed ids, dangling links and
  groups, removed members, missing media / tracks, synthetics deleted, orphaned, swapped or changed kind,
  transitions re-pointed or orphaned, bad expressions, track-matte cycles, remix groups broken by a later delete,
  nest cycles, nested durations shrinking, broken sequence settings, dropped tracks, document fields): incremental
  and verify results equal `checkInvariants` every step. Every rule of the incremental check was removed in turn
  (16 mutations) and the property failed each time. Plus: the id index stays exact over 150 chained transactions
  (past the flattening depth); common edits (param, move, trim, split, keyframe, add solid, lift, effect, update)
  never fall back.
- `normalizers-delta.test.ts`: 200 random chains of 16 command kinds (linked A/V, groups, transitions, captions,
  item deletion…) applied with and without delta scans give equal documents, results and warnings; raw edits
  (an unused synthetic added, a group removed, a clip leaving its group, a synthetic kept by its item); each
  delta rule removed in turn fails a test.
- `draft-read.test.ts`: fast paths active, reads follow writes, reading drafts nothing, `recordDelta` equals a scan
  on 500 random edit sequences, cached reads only for frozen values.
- `derive-incremental.test.ts`: derived per-track indexes equal a full build after every random edit; untouched
  tracks share their lists.
- `packages/session/test/perf-budgets.test.ts`: §13 budgets with the reindex, exact with `PERF=1`, × load × 1.5 in
  the normal gate (the old gate allowed 34 ms / 146 ms × 1.5 × load).
- `apps/engine/test/perf-invariants.test.ts`: `/api/perf` reports the counters.
- `e2e/perf-core.spec.ts` (built app): 1 000 clips added by an agent, ten edits through the agent bridge
  (≈ 85–125 ms per round trip in headless Chrome, bridge included), Shift-click selection and a pointer drag of
  the visible V1 clips commit one history entry with every clip moved right; the editor reports mode
  `incremental`, 11 incremental checks, 1 full (the first transaction). Screenshot `test-results/perf-core-drag.png`.

Measured results: [docs/performance.md](../performance.md) §4 (perf-core).

## 6. Comparison with the references

| | EffectCraft (architecture §7, `engine/src/history.rs`) | FilmCraft (`engine/src/lib.rs`) | Here |
|---|---|---|---|
| Edit model | copy-on-write `Arc<Comp>`; a one-layer edit copies its 5 000-layer comp (≈ 8 ms) | `Arc<Project>` copy-on-write | Immer structural sharing per clip; the changed clip and its records only |
| Undo | pointer swap | pointer swap | pointer swap (0.3 ms), unchanged |
| Validation per edit | none comparable (Rust types; no document invariant pass) | none comparable | full invariant set (INV-001…016, EXPR, MIX, COLOR, ESSENTIAL) on every commit, incremental, fuzz-proven equal to the full pass |
| Small edit on the large project | 8.4–19.7 ms (5 000 layers) | — | 2.3–4.6 ms (5 000 clips / 200 sequences); 1.7–2.8 ms on 1 000 clips |
| Large edit | 18–57 ms (switch on 5 000 layers) | — | 95 ms (300 clips across 200 sequences, full validation included) |
| Autosave | background thread, 0.1–0.2 ms on the UI thread | — | debounced on the main thread, ≈ 100 ms per 8 MB (not changed, §7) |

Equal or better on the edit path and undo, with a much stronger guarantee (every commit validated). Worse on
autosave (see §7). Nothing was ported (no `licenses/ported` record).

## 7. Limits

- **First edit after opening a project runs the full check** (the document is not verified yet): ≈ 25–40 ms on
  5 000 clips, once. Headless engine transactions without an open editor load the project file each time, so they
  always take the full path (`/api/perf` shows `unverified base`); loading dominates them anyway.
- **Fallbacks are full checks**, at the old cost: item / media / transcript edits, sequence settings and track
  edits, sequences added or removed, caption clip edits, nested sequences whose duration changes, deleting the
  last clip of a medium. Their frequency is visible in `invariantStats()`.
- **Immer internals.** `latest` and `recordDelta` read Immer 11's private state; load-time probes switch to public
  APIs (slower, still correct) if the shape changes, and tests fail so it is noticed.
- **Timing on this host.** The budgets are met at load ≤ 15 (three strict runs in §4); at load 25–45 single strict
  runs exceeded them (host contention; the load-scaled gate still passes). A quiet machine was not available.
- **Browser rendering of a drag on 1 000 clips.** In the built app (headless Chrome, SwiftShader, load ≈ 19) a
  30-step pointer drag of 11 clips took 6.8–10.7 s of wall time (`e2e/perf-core.spec.ts` logs it): the gesture
  update and the timeline's derivations are a few ms (§4 benches), so the remaining per-move cost is React
  rendering of the timeline and the Program monitor's re-render of the drawn sequence on a software-rendered
  host; not profiled further in this workstream. Profiled and addressed by workstream `ui-perf`
  ([ui-perf.md](ui-perf.md)): the Program monitor's per-frame snapshot and Player render, hidden panels, expression
  scans and timeline chrome re-renders.
- **Not changed here:** autosave serialisation stayed a debounced main-thread `JSON.stringify` (≈ 100 ms per 8 MB;
  made incremental since by `ui-perf`: ≈ 0.5 ms after a one-clip edit, [ui-perf.md](ui-perf.md)), the render snapshot of all 200 sequences (≈ 470 ms, only built
  per visible sequence in practice), project load (≈ 1.2 s for 8 MB, dominated by parse + zod).

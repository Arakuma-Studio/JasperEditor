# Project panel sorting performance

The Project panel derives its rows when the committed document, media runtime, search, filter, expanded bins or
sort changes (`ProjectPanel.tsx`). Its Name and Frame Rate comparators called `localeCompare` with options for every
comparison. Large bins therefore repeatedly constructed equivalent collation state while sorting on the UI thread.
The model now lazily reuses an `Intl.Collator` for each column. The locale, options, bins-first rule, stable ties,
ascending/descending order, search and formatted values are unchanged. No document or API behavior changes.

Candidates inspected, in priority order (impact was estimated before measurement):

1. Repeated collation setup while sorting large bins: high expected impact, minimal implementation risk; measured
   and implemented below.
2. Repeated media descriptions in `projectRows`: potentially useful on repeated runtime notifications; additional
   identity caches require more invalidation work, deferred.
3. Breadcrumb parent lookup scans every item once per level: proportional to bin depth; less frequent and lower
   expected impact than sorting, deferred.
4. Slide gesture neighbor lookup scans and sorts clips for each selected clip: potential large-selection issue;
   higher behavioral risk in edit constraints, deferred.
5. Track-header context menu counts scan clips per track: user-triggered only, lower expected impact, deferred.

## Measurement

`apps/web/bench/project-sort.ts` calls the actual original and current `projectRows` modules in the same Node process.
Fixtures come from the existing UI fixture generator through the real command system, with deterministic mixed
case/accent/numeric names and varied media frame rates. Full row output equality is asserted before timing. Each
case has two warmups and nine measured samples; implementation order alternates. The User sort is an unchanged
control. Fixture generation, name assignment and equality assertions are outside the measured region.

Measured host: AMD EPYC-Genoa Processor, 8 exposed CPUs, Node 22.23.4, Linux shared host. Load averages at start:
8.76 / 3.70 / 1.43; at end: 11.63 / 4.72 / 1.83. Other work was running on the host. These are measured medians
of the full row derivation, in milliseconds; they are not whole editor interaction or frame-rate measurements.
Raw samples and machine metadata are in `apps/web/bench/project-sort.measurements.json`.

| Items | Sort | Original | Current | Reduction |
| --- | --- | ---: | ---: | ---: |
| 2,000 | Name | 95.25 | 15.38 | 83.9% |
| 2,000 | Frame Rate | 56.42 | 8.05 | 85.7% |
| 5,000 | Name | 250.18 | 45.35 | 81.9% |
| 5,000 | Frame Rate | 147.34 | 34.84 | 76.4% |
| 2,000 | User (control) | 5.18 | 6.94 | unchanged code; host/GC noise |
| 5,000 | User (control) | 28.09 | 26.96 | unchanged code; host/GC noise |

Rerun with a baseline checkout of `8b4c8936` whose dependencies have been installed with
`pnpm install --frozen-lockfile`:

```sh
pnpm exec tsx apps/web/bench/project-sort.ts /path/to/baseline/apps/web/src/panels/project/model.ts
```

Without the optional baseline path the command measures the current implementation. No external algorithm or code
was ported; the workload and expected behavior come from the existing model.

## Validation and limits

`pnpm exec vitest run apps/web/test/project-sorting.test.ts apps/web/test/wp2e/ui.test.tsx --maxWorkers=2` passed
(16 tests). The four collation tests cover both directions, bins first, numeric names/rates, mixed case and accents,
non-Latin names, and stable ties, comparing full row output with the previous comparator. Existing Project panel
tests cover bin navigation/search, moving media and deletion confirmation. `pnpm --filter @jasper/web typecheck`
and focused Biome checks passed.

The integration owner runs the final whole-repository gate and browser visual verification. The change affects
presentation ordering work only; it does not alter preview/export rendering. Media formatting and usage scans remain
part of row derivation, and the existing large-bin windowing remains responsible for limiting mounted rows.

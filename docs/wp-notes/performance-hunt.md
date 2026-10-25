# Performance investigation

The investigation starts at commit `8b4c8936`. Each implementation has its own
repeatable benchmark and evidence note; the integrated gate is recorded below.
No document schema, persistence format or editing API change is intended.

## Critical paths

- Home and project opening: download and evaluate the SPA, open/validate a
  project, resolve media status, mount the editor and its Project panel.
- Interactive editing: select/deselect linked clips, search the timeline,
  sort project items, execute undoable commands and publish session changes.
- Playback and scrubbing: derive render snapshots, mount visible compositions,
  decode media and resample audio to the output rate.
- Background engine work: look up active derivative jobs, generate media
  derivatives, render exports and persist project state.

The existing scale, Chrome trace, bundle-recovery and audio-oracle tools are
used alongside small standalone benchmarks of the affected production calls.
The workers use separate branches/worktrees; timings must record host load
because builds and tests share the machine.

## Ranked opportunities before implementation

These are expected effects from source inspection, not measured speed claims.
Only candidates confirmed by before/after measurements will be integrated.

1. **Timeline Find:** source-name matching scans project items for every clip.
   A per-search lookup should remove the clips × items traversal on large bins,
   preserving first matching item names and search ordering.
2. **Project sorting:** `localeCompare` options are supplied for each comparison.
   A reusable `Intl.Collator` should reduce sort setup work while retaining the
   same locale, numeric ordering and tie behavior.
3. **Audio resampling:** coefficient tables are rebuilt for each short buffer.
   Bounded reuse should cut repeated scrubbing setup while retaining every
   convolution operation and exact output samples.
4. **Media status:** each status lookup clones/sorts all active jobs before
   selecting a handful of derivative keys. Filtering before cloning should cut
   opening/import overhead without weakening validation or changing readiness.
5. **Bulk deselection:** removal checks every selected ID against an array of
   removed IDs. Set membership should remove quadratic work while retaining
   order, domain behavior and linked selection rules.

A sixth investigation checks whether the catch-all vendor chunk pulls optional
dependencies into Home. It will proceed only if the emitted graph and browser
requests confirm a worthwhile, safe reduction.

## Evidence and integration

Pending measured results and the integrated verification gate.

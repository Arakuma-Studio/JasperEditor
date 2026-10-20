# Camera accuracy oracle correction

This ledger was written before editing the tests, in the isolated `prune2-camera-metric` worktree based on integration commit `2664ee01`. No production behavior changes or production test seams are needed. These are corrections to already retained declarations, not additional test cases or additional disposition counts.

## Provenance and metric

Independent behavior comes from the authored cameras in `movingCamera` and `scripts/fixtures/camtrack.mjs`, the axis-angle/canonical-space API in `packages/api/src/camtrack.ts`, and the accuracy limits in `docs/wp-notes/three-d.md` lines 138–145. The work note specifies path error relative to path length, but does not independently specify a fitting gauge. The original tests at `6c2baa39` explicitly measured the maximum position residual **after the least-squares best similarity**, divided by the **full authored trajectory length**. The recorded accuracy measurements used that convention. The endpoint gauge introduced during cleanup was an undocumented change to the oracle, not an equivalent way to calculate that metric.

The difference affects verdicts: authored scalar positions `[0, 0.5, 1]` and solved positions `[0.025, 0.5, 1.025]` have 2.5% endpoint-fit error but maximum best-fit error `20/1201`, approximately 1.6653%. The endpoint metric also divided by the first-to-last solved segment in the core suite, changing the denominator when endpoint frames were unsolved. This correction preserves the original convention and thresholds; it does not relax them to match an observed result. No runtime assertion values were available when this decision was made.

The independent least-squares similarity objective is described by [Umeyama (1991), Least-Squares Estimation of Transformation Parameters Between Two Point Patterns](https://web.stanford.edu/class/cs273/refs/umeyama.pdf), also cited in the original work note. The following rank-one specialization is our mathematical derivation; no upstream implementation is copied.

For these straight, constant-speed fixtures, write each authored position as `b + L*t*d`, where `t = frame/(fullTruthFrameCount - 1)`, `d` is a unit direction and `L` is the full path length. Center the observed vectors `x` and scalar times `u`. Let `v = sum(u*x)`, `V = sum(dot(x,x))`, `a = norm(v)/V` and `h = v/norm(v)`. A least-squares proper rotation aligns `h` with `d`; translation aligns the centroids. Its scale divided by `L` is `a`. A normalized residual therefore has axial component `a*dot(h,x)-u` and perpendicular magnitude `a*norm(x-dot(h,x)*h)`. Their Euclidean norm, maximized over the same observations as before, is the original normalized error. No SVD, alignment code, vector helper or expectation is imported from production.

The core suite originally fit only solved frames, but normalized by the full truth span; the job suite fit every returned frame, including interpolation. Preserve both observation sets. Fewer than three observations, zero observed variance and an observed frame outside the truth trajectory are rejected; trailing unsolved frames remain omitted. With positive variance but zero covariance, the least-squares optimum has zero scale and the residual is the maximum absolute centered truth scalar, preserving the original fit rather than refusing that case.

Rotation review found a second changed convention in the core suite: the original test compared `R_k * transpose(R_0)` on both sides, whereas the rewrite compared the decoded output directly to relative truth. Restore the original relative-to-first-frame comparison for frames after frame zero, using independent quaternion decoding and explicit row dot products. The job suite already preserves this relative convention with a quaternion sandwich. The chord-angle identity `angle = 2*asin(norm(A-B)/(2*sqrt(2)))` is equivalent to the original rotation-log norm for rotations; it needs no metric change.

## Before-edit dispositions

### REWRITE — `apps/engine/test/camtrack-solve.test.ts` / `Fixed Angle of View: finds the focal length and the path of a dolly`

1. The authored 40-frame camera and work-note limits specify focal error below 3%, best-fit path error below 2%, and relative rotation error below 0.3 degrees; the fitting convention above preserves the original measurement.
2. A wrong camera path, focal length or orientation misplaces tracked scene content and fails these numerical outputs.
3. Literal focal values, authored camera matrices and analytic collinear similarity are independent of the solver and its SVD/Rodrigues/logarithm code.
4. `solveCamera` returns the stable camera solve consumed by the engine worker; no private call shape is inspected.
5. Solver search, bundle adjustment, data structures and rotation encoding implementation can change while preserving the returned camera contract.
6. This is the lowest stable solver seam with independently prescribed noisy observations; the real-plate job additionally owns feature extraction/HTTP but does not replace the synthetic 3%/2%/0.3-degree acceptance case.

Risk: an actual numerical regression remains a failure; only the changed oracle convention is corrected. Non-test caller: camera worker invokes `solveCamera`; no source export changes. Validation: focused core suite and engine typecheck at integration, with unchanged 120-second test budget.

### REWRITE — `apps/engine/test/camtrack-solve.test.ts` / `Specify Angle of View: uses the given focal length`

1. The camera setting specifies a 40-degree horizontal view and its authored trajectory; the retained exact focal and 2% best-fit path limits remain unchanged.
2. Ignoring the supplied field of view or solving the wrong trajectory fails the returned camera measurements.
3. The focal literal and analytic best-fit residual depend on fixture geometry, not solver helpers.
4. Observe the returned `solveCamera` result through the stable solver interface.
5. Internal optimization and parameter representation can change without altering this expected behavior.
6. Automatic focal estimation tests do not own the explicit field-of-view constraint; the solver is its lowest stable owner.

Risk/callers: as above; unchanged 120-second budget. Validation: focused core suite and engine typecheck at integration.

### REWRITE — `apps/engine/test/camtrack-solve.test.ts` / `Variable Zoom: follows a zoom during the move`

1. The authored linear 30% zoom and trajectory specify per-frame focal accuracy below 6%; preserve the original 4% best-fit path limit and full trajectory denominator.
2. A fixed/incorrect focal estimate or incorrect reconstructed motion yields wrong tracked zoom/motion.
3. The authored zoom function and analytic collinear fit are independent of the implementation's per-camera focal optimization.
4. Read the stable solve's per-frame focal values and centers.
5. The optimizer and smoothness prior can be refactored without changing the contract.
6. Fixed-focal cases cannot detect failure to follow variable zoom; this solver seam uniquely isolates it from image feature extraction.

Risk/callers: as above; unchanged 180-second budget. Preserve the original solved-frame selection. Validation: focused core suite and engine typecheck at integration.

### REWRITE — `apps/engine/test/camtrack-solve.test.ts` / `Auto Detect: a pan from a tripod is solved as a pure rotation`

1. The authored stationary-center pan and work note specify tripod classification, focal error below 3%, relative rotation below 0.3 degrees and zero camera travel.
2. A spurious dolly or inaccurate pan moves tracked content incorrectly.
3. Independently authored camera directions and quaternion decoding preserve the original relative-rotation metric without sharing production log/rotation helpers.
4. Observe the solver result's public method, focal values, rotations and centers.
5. Classification/optimization internals can change without invalidating correct results.
6. Moving-camera cases cannot own the pure-rotation degeneracy; the stable solver seam is the lowest owner.

Risk/callers: as above. Only the rotation gauge calculation changes; the center/focal assertions and 120-second budget remain unchanged. Validation: focused core suite and engine typecheck at integration.

### REWRITE — `apps/engine/test/camtrack-solve.test.ts` / `Auto Detect: a scene of one plane is solved (Flat)`

1. The authored coplanar scene and work note specify flat-scene detection; preserve the original 3% best-fit path criterion for the known straight trajectory.
2. A wrong planar reconstruction or motion path visibly misplaces tracked layers.
3. Expected scene classification and analytic best-fit residual are independent of homography decomposition and bundle adjustment.
4. Read the stable solver result for prescribed tracked observations.
5. Homography/RANSAC internals can change while returning equivalent camera motion.
6. General 3D and tripod tests do not cover the planar degeneracy; this is the lowest solver seam for it.

Risk/callers: as above; unchanged 120-second budget. Validation: focused core suite and engine typecheck at integration.

### REWRITE — `apps/engine/test/camtrack-job.test.ts` / `solves the camera of the plate: focal length, path and rotation against the truth`

1. The independent ray-cast fixture supplies the known straight dolly and camera rotations; the work note records 5% best-fit path accuracy. Preserve the original 4% focal and 0.5-degree relative-rotation checks.
2. Incorrect video tracking or published camera results misalign scene content; incorrect center output fails the independent best-fit residual.
3. Authored fixture geometry and the analytic rank-one fit cannot share production alignment bugs. Rotation remains independently decoded through quaternions.
4. POST solve, GET job and the published camera result are stable caller interfaces.
5. Feature extraction, worker serialization and solver internals can change without breaking correct output.
6. Synthetic core cases cannot cover actual video decoding, image features, child process and HTTP publication together; this remains the lowest real-plate workflow.

Risk: a genuine published-path regression remains visible. Callers/seams: no new production code, seam or caller; shared oracle lives only in test support. Preserve every returned frame in the fit and the 600-second budget. Validation: focused job suite and engine typecheck at integration.

## Validation

Completed local checks: scoped Biome check passed all three TypeScript files; TypeScript parse/transpile diagnostics passed those three files; a strict semantic check with `noUncheckedIndexedAccess` passed the isolated path oracle. Independent mathematical review confirmed the rank-one fit, full-span normalization, observed-frame selection, zero-covariance case and restored relative rotation. The staged diff and whitespace checks were reviewed before committing. No heavy runtime jobs or helper self-tests are added. Root will run `pnpm exec vitest run apps/engine/test/camtrack-solve.test.ts apps/engine/test/camtrack-job.test.ts --maxWorkers=1` and engine typecheck after the current batches. Runtime failures remain unclassified until their actual stacks are available.

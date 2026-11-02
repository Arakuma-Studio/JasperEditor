# Title Looks: the fixes it depends on (spec 19 §13, TL-120 to TL-125, TL-002, TL-004)

Branch work on top of `worktree-title-looks`. Each fix has a regression test that failed before it (output in the
report). Nothing here is Title-Looks specific: they are repairs of general paths that the looks stress.

## TL-120 Media use-counting (data loss)

**Bug.** `clipParamMediaIds` returned `[]` for everything but motion-graphic clips, so a light's `environmentMediaId`
and an effect's `{mediaId}` param (LUTs, maps, reflection images) were not uses. `item.delete` skipped `E_IN_USE`
(the transaction then failed on a dangling reference, E_INVARIANT, instead of naming the clips), `collectOrphans`
dropped the medium once its item was gone, Project Manager "Exclude Unused" and `mediaUsage` ignored it, INV-014 did not
count it and repair nulled the light's environment; `media.removeUnused` did not read `environmentMediaId`.

**Fix.** One definition, `clipParamMediaIds(clip)` in `packages/project/src/param-media.ts`: template params, a light's
environment, and every `{mediaId}` of the clip's effect params, keyframes included (`effectMediaRefs`), each once. Every
caller (`clipRefs`, `orphanRefs`, `usedMedia`, `mediaUsage`, clipboard, interchange export, snapshot, incremental and
full INV-014) counts them without change. New: `clearEffectMedia`.
- `item.delete` with `force` clears the references and keeps the clip: template params to `null`, a light's environment
  to `null` (neutral studio light), effect params to `{mediaId: ''}` (None; effect params have no null). The result's
  `clearedParams` lists `light.environmentMediaId` / `effects.<effect id>.<param>`.
- `repairDocument` clears a dangling effect `{mediaId}` to None (`clear-effect-media`), as it already did for lights and
  template params. Before, INV-006 reported it and nothing repaired it.
- Paste into another project remaps a light's environment image (it was not carried or remapped).
- `media.removeUnused` counts `environmentMediaId` like `mediaId`.

**Not counted (recorded in gaps.md).** Transition params with `{mediaId}` (gradient wipe images) and track, submix and
master effects. Track and master effects are audio effects, which take no media; transitions are the open case
(`media.removeUnused` does read them, the other paths do not).

## TL-121 Seeds and frame counters across razor cuts

**Bug.** `fxSeed` hashes the clip id and the effect instance id. `splitClipAt` gives the right part new ids, so every
seeded pattern jumped at the cut, and `u_frame` / `u_time` restart at 0 in the right part (clip-local), so animated
patterns jumped too.

**Design.** `EffectInstance.patternOrigin?: {clipId, effectId, frame}` (persisted, `z.custom`, read leniently by
`readPatternOrigin`, bounded to `PATTERN_ORIGIN_MAX_FRAME`):
- `fxSeed(clipId, fxId, params, origin)` hashes the origin's ids when there is one. No origin = the instance's own ids,
  so unsplit clips and every existing golden are unchanged.
- `u_frame` / `u_time` get `origin.frame` added per effect step (`fxOffsetBuiltins`, in `FxPicture`), and
  `FxFrameContext.patternFrame` (= `frame + origin.frame`, read with `fxPatternFrame(ctx)`) feeds hooks that hash a
  frame number (film grain frame index, dust and stain counts, lightning zap seed, strobe randomness).
- `reidentifyClipChildren` stamps the origin on a clip's GPU effects before they get new ids. A split passes the frames
  the right part starts into the left (`at - clip.start`), so the offsets add up over repeated cuts; the left part keeps
  its own ids and needs no origin.

**Duplicate and paste keep the pattern** (identical copy, offset 0 from the copied instance's own offset). Why: a
duplicate is expected to look exactly like its source (After Effects and Premiere copy the seed as a parameter value;
spec 19 TL-011 says the appearance `seed` survives split, duplicate and paste), and a title copied to another place must
not change texture. The cost is that two stacked copies draw the same grain; the numeric `seed` param (Sapphire "Seed",
mixed into `u_seed`) differentiates them on purpose. Before this change a duplicate drew a different pattern because its
ids differed; that was an accident of hashing ids, not a rule anyone relied on.

**Limits (gaps.md).** `u_clipProgress`, `u_duration` and keyframes stay clip-relative (a fade-in effect restarts in
the right part by design). Effects that derive their own clock from `ctx.frame` inside a `uniforms` hook (wiggle,
weather, wave world, flicker) and stepped simulations (`fxSimRun`) still restart at the cut: `ctx.frame` mixes clock,
progress and keyframe uses, so only the pure per-frame hash sites were moved to `fxPatternFrame`.

**Schema.** The field is new data an older build would not honour. It rides schema v12 (the Title Looks bump); the
integrator must see that v12's `STEP_CHANGES`, fixture and `docs/project-files.md` row cover it. The fields table has a
row for it already.

## TL-122 `contentBleed` honours `gpu.padding`

`contentBleed(c, registry, span?)` (apps/engine/src/layer-bake/layer.ts) adds, for every enabled GPU effect, the largest
side of `gpu.padding` over the clip's frames `[f0, f1)` with params evaluated per frame (`fxParamsAtFn`, the hook's own
`paramsAt`) when they animate or the effect is time dependent, else at the first frame. Per effect the maximum is
summed, which is never smaller than the real stacked per-side padding (conservative). Null (full-frame bake) stays when
the frames are not given, the effect has no GPU realisation, the hook throws or returns non-finite, or an animated span
is longer than `MAX_PADDING_FRAMES` (20 000). `cropRect` passes its frames and the sequence rate.

## TL-123 Float-only effects

`GpuEffect.requiresFloat?: boolean | string` (a string is the refusal code, e.g. `TITLE_LOOK_NEEDS_FLOAT`; `true` gives
`FX_NEEDS_FLOAT`; validated by `validateGpuEffect`). `fxFloatRefusal(spec)` is the one place that builds code and
message. Without `EXT_color_buffer_float` (`canUseFloatTargets()`, cached with the WebGL2 probe):
- preview: `planLayerFx` bypasses the effect (reason `needs-float`) and the layer's chip says which effects are not drawn;
- render: the layer cancels with the effect's code; the host itself refuses a plan with `requiresFloat` rather than use
  its 8-bit fallback in `target()`; the engine maps `*_NEEDS_FLOAT` to a job error code;
- export plan: see TL-124.
Effects that do not declare it keep the fallback.

## TL-124 WebGL in the export plan

`PlanCapabilities.webgl?: () => Promise<WebglStatus>` ({state, floatTargets, message}). The engine wires it to
`RemotionService.probeWebgl()`, which opens the render browser once and caches the answer; it now also records
`EXT_color_buffer_float`. `planExport` awaits it only when the chosen path is `remotion` (everything) or `hybrid` (the
baked layers and transitions) and `snapshotGlNeeds` finds something. `webglRefusal` (`remotion/webgl-refusal.ts`, shared
with the Remotion service) turns `unavailable` into `WEBGL_UNAVAILABLE` and a missing float target into the effect's
float code; the `PlanError` (409) carries `blockers` naming each effect, transition, blend mode or 3D layer and its
clip. `unknown` (not probed because Remotion is not ready) refuses nothing: the render decides, as before. A native-only
sequence never triggers the probe.

## TL-125 `docHasColorEffects` replaced by `snapshotGlNeeds`

`snapshotGlNeeds(doc, registry)` (`packages/project/src/render/gl-needs.ts`) walks a render document structurally and
boundedly (depth 16, 200 000 nodes, cycle-safe, any input): enabled colour and GPU effects on every clip including
adjustment layers, nested snapshots (any depth) and matte tracks; enabled CSS-only effects with active masks and layers
with active Opacity masks (`activeMasks`' test: not mode none, a closed path of 2+ vertices); GPU transitions; blend modes
CSS cannot draw (`isCssBlend`); 3D layers. `RemotionService.assertWebglFor` and the planner both use it.
Not included: the colour working-space injection (it arrives as an effect on the clip and is found as one).

## TL-002 and TL-004

`licenses/texts/LicenseRef-Pachislop.txt` states that the author (SafEight) gave permission by direct message on
2026-11-02 and that the repository has no licence file, and that the permission covers only what the port records name.
No port record exists yet, so `pnpm notices` lists none for it. `scripts/third-party-notices.mjs` introduces the ported
records with "these projects", because a record may name a source without an open-source licence. `THIRD_PARTY_NOTICES.md`
is regenerated by the integrator (`pnpm notices`); until then `scripts/third-party-notices.test.mjs` "is current" fails.

## Evidence

Tests: `packages/project/test/media-use-counting.test.ts`, `pattern-origin.test.ts`, `gl-needs.test.ts`;
`apps/engine/test/gpu-bleed.test.ts`, `webgl-plan.test.ts`; `packages/compositions/test/fx-float.test.ts`;
`scripts/third-party-notices.test.mjs`. Not covered by an automated test: the host's own float refusal (needs a GL
context without `EXT_color_buffer_float`; SwiftShader has it) and the preview chip text.

# Track Matte hold-out: Matte = None, edge decontamination, export route

Branch `fix/track-matte-holdout`. Builds on [masks.md](masks.md) §4 (track mattes). Report from the VFX team: a
SAM 2 foreground matte used as a Track Matte over a new background shows the old background's colour as a halo in
the soft edge; `set_track_matte {matteTrack: null}` left a key without a track, which hid the clip.

## 1. Analysis: is the halo a compositing bug?

Measured with `packages/compositions/test/track-matte-holdout.e2e.test.ts` (REMOTION_E2E, headless Chrome with
SwiftShader on the shared Linux host, 640×360): a plate I = αF + (1 − α)B with a 24 px linear soft edge, its matte α
on a hidden track, a new background N underneath.

- The plain key equals the CPU reference α·I + (1 − α)·N within **max 1.33, mean 0.018** code values over the whole
  frame. Alpha is applied to the premultiplied picture (`src * k`), the matte composite is premultiplied "over"
  (Porter & Duff 1984) with linear filtering of premultiplied textures, uploads are premultiplied
  (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`), and the sequence-space sample lands on pixel centres. Alpha is not a colour, so
  the matte's resampling does not depend on the colour space. **No premultiplied/straight mismatch and no
  colour-space resampling error.**
- The halo is the matting equation itself: the plate's edge pixels already hold (1 − α)·B, so the key composites
  α·I = α²F + α(1 − α)B over N. Measured against the true foreground over N: **max 44.6, mean 13.3** code values in
  the edge band. Only knowing (or estimating) B removes it.
- Two real bugs were found on the way:
  1. **Hybrid export dropped track mattes.** A Track Matte Key is a GPU effect, so the layer bake claimed the fill;
     its render document (`bakeDoc`) holds the clip alone, without the matte track, so the key had no matte: the
     clip exported fully visible (with Reverse: invisible). The planner now names the key as a native blocker
     (`nativeBlockers`, "uses a Track Matte Key reading track …, which only the Remotion path renders"), so the fill
     renders on the Remotion path with its tracks, exactly as the preview.
  2. **Matte = None with Reverse was fully transparent.** The shader returned `vec4(0)` for Reverse when no matte was
     bound. No matte is now "no matte" on every path: the layer passes through unchanged.
- One resampling limit, not a bug of the team's setup (plates at 100 %): the matte is sampled on the fill layer's own
  pixel grid (the fx chain runs in layer space), so a fill scaled above 100 % gets its matte resampled to that coarser
  grid (edges softened by up to the scale factor). After Effects applies track mattes after the transform. Recorded in
  [gaps.md](../gaps.md).

## 2. `set_track_matte {matteTrack: null}`

The MCP tool now removes the Track Matte Key (`effect.remove`, one History entry; nothing to do when the clip has
none). The tool text already said "matteTrack null removes the matte", so no model-visible text changed. A key that
still exists with Matte = None (Effect Controls ▸ Matte ▸ None, or older files) passes the layer through in the
shader, the bake and every export path. A matte *track* that exists but has nothing at a frame is still an empty
matte (the fill is hidden there), as in Premiere and After Effects.

## 3. Decontaminate Edges (the hold-out feature)

New Track Matte Key params (schema v17, [project-files.md](../project-files.md)):

| Param | Values | Meaning |
|---|---|---|
| `decontaminate` | `off` (default) · `cleanPlate` · `estimate` | Decontaminate Edges |
| `cleanPlateTrack` | video track id (track picker) | Clean Plate: a track holding the background without the subject, read in sequence space like the matte track (hidden tracks work; INV-006 / INV-012, repair `clear-track-matte`, track remaps and temp refs as `matteTrack`) |
| `searchRadius` | layer px, default 32 | Background Search Radius of the estimate |

Method. With α = the key's matte value at the pixel (after Composite Using and Reverse) and the fill's straight
colour I, the matting equation I = αF + (1 − α)B (Smith & Blinn 1996, §2) gives the premultiplied foreground

    αF = clamp(I − (1 − α)·B, 0, α)        (per channel; output alpha α, times the fill's own alpha)

No division: the premultiplied form cannot amplify noise at small α, and the clamp keeps 0 ≤ F ≤ 1. Composited
over a new background N it gives exactly I with B replaced by N in the edge. Pixels with α = 0 or 1, or with no B,
are the plain key.

- **Clean Plate Track** (`cleanPlate`): B is the clean-plate track's composite at the pixel's sequence position
  (bound as `u_cleanPlate`, the same `TrackMatteHub` machinery as the matte). Exact up to 8-bit storage.
- **Estimate from Background** (`estimate`): B is estimated from the fill's own pixels around the edge that the
  matte leaves out: a normalised convolution (Knutsson & Westin 1993) over a 64-tap golden-angle disc of radius
  `searchRadius`, each tap weighted by (1 − α)⁸ (nearly pure background only), the tap's alpha and a Gaussian of the
  distance (σ = radius / 2). This is the background half of Blur-Fusion (Forte & Pitié 2021: B̂ = blur(B·(1 − α)) /
  blur(1 − α)) in one pass, followed by the exact unmix above instead of Blur-Fusion's F update. **Our choices,
  tuned on the synthetic edge only:** the exponent 8, σ = r/2, 64 taps.
- **Space.** The unmix runs in the values the stack stores and blends (encoded, the default blending), which makes
  the round trip exact for Normal blending. With Blend using 1.0 gamma it is not the inverse of the linear blend
  (recorded limit).

Implemented once, in the Track Matte Key shader (`packages/project/src/registry/fx/premiere-adjust-color-keying/keying.ts`),
which every renderer runs: the Program preview (Remotion Player), Remotion stills and exports, and PSD export (a matted
layer is flattened into a whole-stack render). The native kernel has no Track Matte Key and the layer bake cannot
draw the tracks it reads, so the planner refuses those paths by name for a key that reads a track (§1), and the
export renders the clip on the Remotion path.

How to use (hold-out over a new background): the plate on V2 with the Track Matte Key, Matte = the foreground matte
track (hidden), Decontaminate Edges = Clean Plate Track with the clean plate on another hidden track (or Estimate
from Background), the new background on V1. The key belongs on the plate; a key on the new background (a reversed
matte over the plate) cannot remove the plate's contamination below it.

## 4. Files

| What | Where |
|---|---|
| Shader, params | `packages/project/src/registry/fx/premiere-adjust-color-keying/keying.ts` (`TRACK_MATTE_KEY`) |
| Track params / bindings | `packages/project/src/masks/track-matte.ts` (`TRACK_MATTE_TRACK_PARAMS`, `trackMatteBindings`, `trackMatteTracksOf`) |
| Binding the composites | `packages/compositions/src/fx/stage.ts` |
| Invariants, repair, remap | `packages/project/src/invariants.ts`, `commands/handlers/structure.ts` |
| Export route | `apps/engine/src/export/planner.ts` (`nativeBlockers`) |
| MCP | `apps/mcp/src/tools/masks.ts` (`set_track_matte`) |

## 5. Tests and figures

| Test | Checks |
|---|---|
| `packages/compositions/test/track-matte-holdout.e2e.test.ts` (REMOTION_E2E) | plain key = CPU over (max 1.33 / 255); halo vs true foreground max 44.6, mean 13.3; Clean Plate = CPU unmix max 1.31, vs true foreground max 2.05, mean 0.42; Program preview = export render (max 0); Estimate vs true foreground max 6.9, mean 0.93 and unchanged outside the edge |
| `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts` (Chrome GL) | Matte = None with Reverse passes the layer through; clean-plate unmix of one pixel |
| `packages/compositions/test/fx-gl.test.ts` | fingerprint `jasper.track-matte-key@perturbed` (Reverse, no matte) re-blessed: was all zero (transparent), now the source picture |
| `apps/engine/test/fx-routing.test.ts` | a key reading a matte / clean plate track is a native blocker even when a bake claims the clip; Matte = None is not |
| `apps/mcp/test/masks.test.ts` | `set_track_matte {matteTrack: null}` removes the key, twice is a no-op |
| `packages/project/test/masks-commands.test.ts` | the clean plate track: hidden track in `matteTracks`, own track refused, in-use track removal refused, repair clears a missing one |
| `packages/project/test/schema-history.test.ts` | v17 fixture loads without repairs and survives save and reload |

Not measured: the estimate's cost per frame (64 taps on edge pixels only; pixels with α = 0 or 1 return early).

## 6. Limits

- Estimate from Background is an approximation (one estimate, no iteration); wide soft regions far from pure
  background (hair against busy backgrounds) need the clean plate or a larger radius.
- Unmixing in encoded values only (see §3, Space).
- Matte sampled on the fill's pixel grid (§1).
- Track Matte Keys that read a track export through Remotion only.

## 7. References

- A. R. Smith, J. F. Blinn, "Blue Screen Matting", SIGGRAPH 1996 — the matting equation and the known-background
  solution.
- T. Porter, T. Duff, "Compositing Digital Images", SIGGRAPH 1984 — premultiplied alpha and "over".
- H. Knutsson, C.-F. Westin, "Normalized and Differential Convolution", CVPR 1993 — normalised convolution.
- M. Forte, F. Pitié, "Approximate Fast Foreground Colour Estimation", IEEE ICIP 2021 — Blur-Fusion's background
  estimate.

Only published equations were used (no code was ported), so there is no `licenses/ported/` record, as for the
tracker's ESM and inverse-compositional references ([wp-m2-track.md](wp-m2-track.md)).

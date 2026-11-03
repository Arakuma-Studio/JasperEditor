# wp `three-d` — 3D layers, cameras, lights, Classic / Advanced 3D, 3D models and the 3D Camera Tracker

Branch `feat/three-d` (parity program). Ports: [`licenses/ported/three-d.md`](../../licenses/ported/three-d.md)
(EffectCraft `render/three_d`, `gpu/shaders/classic3d.wgsl`, `track/camtrack`) and
[`licenses/ported/three-d-earcut.md`](../../licenses/ported/three-d-earcut.md) (mapbox/earcut).

## 1. What exists now

| Feature | Where |
|---|---|
| 3D Layer switch on visual clips (`threeD`: Z Position, Anchor Z, Z Scale, Orientation, X/Y Rotation, Auto-Orient, Material Options, Geometry Options) | `packages/project/src/schema/three-d.ts`, `schema/sequence.ts` (`visualShape.threeD`) |
| Camera and light clips on video tracks (`camera`, `light` kinds; one-/two-node rigs, lens, depth of field, iris; parallel / spot / point / ambient / environment, falloff, shadows) | `schema/three-d.ts` (`CameraDataSchema`, `LightDataSchema`), `registry/kinds.ts` |
| Sequence 3D renderer (`threeD.renderer` classic / advanced, draft, shadow map size) | `schema/three-d.ts` (`Sequence3DSchema`) |
| 3D model layers (`model` media kind, `model` clip kind) | `schema/media.ts`, `schema/sequence.ts` (`ModelClipSchema`), `three-d/gltf.ts` |
| 3D Camera Tracker on video clips (`cameraTracker`: span, settings, deleted points, solve, ground plane) | `schema/three-d.ts` (`ClipCameraTrackerSchema`), ids `ctk_` |
| Scene evaluation: active camera (topmost on), lights, world matrices, auto-orient, runs of consecutive 3D layers | `packages/project/src/three-d/{math,model,scene,tools}.ts` |
| Classic 3D CPU reference (plane compositor, Blinn-Phong, ray-cast shadows, bokeh DOF) | `three-d/{classic,bokeh}.ts` |
| Classic 3D on the GPU (WebGL2 on the fx host) | `packages/compositions/src/three-d/gl.ts` |
| Advanced 3D on the GPU (rasterised meshes, MSAA, GGX, shadow maps, environment light, screen-space DOF, models) | `packages/compositions/src/three-d/advanced.ts`, `extruded.ts`, `model-loader.ts` |
| Floating-point pipeline: environment prefilter, tone mapping, glints, resolve, composite (§9) | `packages/compositions/src/three-d/hdr-passes.ts`, `env-loader.ts` |
| Extrusion geometry (contour tracing, earcut, bevel profiles) | `packages/project/src/three-d/{extrude,triangulate}.ts` |
| 3D titles: bevel bands, wavefront rings, offsets, inflate, plates (§9) | `packages/project/src/three-d/{bevel,solid,offset,inflate,title-solid}.ts` |
| Surfaces, presets, slots; scene look; validation and repair (§9) | `packages/project/src/three-d/{surfaces,scene-look,validate}.ts` |
| Radiance `.hdr` reader and prober (§9) | `packages/project/src/three-d/hdr.ts`, `apps/engine/src/three-d/hdr-prober.ts` |
| Composition integration (3D scopes over run bottoms, taps, fallback with CSS homographies) | `packages/compositions/src/three-d/scope.tsx`, `SequenceComposition.tsx`, `layers/ModelLayer.tsx` |
| Commands: `clip.set3d`, `clip.addCamera`, `clip.addLight`, `camera.settings`, `light.settings`, `camera.orbit/pan/dolly`, `sequence.set3dRenderer`, `cameraTracker.add/settings/setResult/deletePoints/setGround/create/remove` | `packages/project/src/commands/{schemas,handlers}/three-d.ts`, `handlers/camtrack.ts` |
| Properties (`threeD.*`, `camera.*`, `light.*`) for param.set / keyframes / expressions | `packages/project/src/registry/three-d-properties.ts` |
| Expressions: 3D-aware `toComp` / `fromComp` / `toWorld` / `fromWorld` | `packages/expressions/src/{world,prelude}.ts` |
| Invariants and repairs (INV-012 3D on wrong kinds, model layers always 3D, tracker solve shape; INV-006 missing media) | `packages/project/src/invariants.ts` |
| Export: 3D runs on the Remotion path (planner blocker), layer bake skips 3D, snapshot warnings for what Advanced 3D does not draw | `apps/engine/src/export/planner.ts`, `layer-bake/*`, `packages/project/src/render/snapshot.ts` |
| Interchange: 3D layers pre-rendered (`3D layer`, `3D model layer`), 3D placement / cameras / lights reported | `packages/interchange/src/{prerender,jasper-export}.ts` |
| Camera solver (port) and feature tracker | `apps/engine/src/camtrack/core/*`, `camtrack/features.ts` |
| `camtrack` job, `jasper-camtrack` child process, tracks cache, `POST /api/camtrack/solve` | `apps/engine/src/camtrack/{service,entry}.ts`, `worker/{cli,run}.ts`, `routes/camtrack.ts`, `packages/api/src/camtrack.ts` |
| Model asset prober (.glb / .gltf / .obj → kind `model`) | `apps/engine/src/three-d/model-prober.ts` |
| Web: Effect Controls 3D switch and sections, Properties 3D / Material / Camera / Light, Camera / Light Settings dialogs, Program monitor 3D overlay (view chip, wireframes, axis gizmo, Camera tool), 3D views (F10 / F11 / F12), menus, New Item ▸ Camera / Light, Track Camera, Properties ▸ 3D Camera Tracker, track-point overlay | `apps/web/src/three-d/*`, `three-d/camtrack/*`, `commands/three-d.ts`, `panels/effectControls/items.ts`, `panels/properties/ClipProperties.tsx`, `shell/menus/model.ts` |
| MCP tools (15) and `THREE_D_GUIDE` | `apps/mcp/src/tools/three-d.ts` |
| Fixture: ray-cast dolly plate with a known camera | `scripts/fixtures/camtrack.mjs` → `fixtures/media/camtrack-dolly.{mp4,json}` |

## 2. Design

**Coordinates are After Effects'.** World space is sequence pixels (x right, y down) plus z away from the viewer. A
3D layer maps layer → world by `T(position, positionZ) · Orientation · Rz · Ry · Rx · S · T(−anchor)`; the default
camera is 50 mm at `(w/2, h/2, −zoom)` with `zoom = w · 50 / 36`, so a 3D layer left at its defaults sits exactly
where its 2D Motion puts it (tested). Angles are degrees, clockwise on screen.

**Runs.** Consecutive 3D layers in the stack (no 2D layer between them; adjustment layers and transition spans are 2D)
form a *run* that is rendered together; a 2D layer splits runs (`runs3d`). Each layer renders its own picture as
usual (source, masks, effects) and hands it to the run (`LayerTap`) instead of drawing; a `Scene3DScope` on the track
at the bottom of the run captures the composite below (HTML-in-Canvas) and draws the run over it with the 3D renderer
through the fx host's shared WebGL2 context. 3D members render outside every scope (a capture nested in another
capture never paints). Renders hold the frame until every member delivered that frame's picture. Without WebGL2 /
HTML-in-Canvas (a browser without the flag) 3D layers are drawn through their homography with CSS `matrix3d` (no depth
sort, lights or DOF) with a chip saying so, and renders cancel with `WEBGL_UNAVAILABLE` / `THREE_D_UNSUPPORTED`.

**Classic 3D** (After Effects' Classic 3D): every layer is a plane; per output pixel every plane is inverse-mapped
through its homography (exact perspective, bilinear sampling, transparent outside), its depth taken from the plane
equation, the fragment lit (Blinn-Phong from both sides, spot cones, falloff none / smooth / inverse square, ray-cast
shadows against the casting planes with Light Transmission tint), the fragments insertion-sorted far → near (coplanar
by stack order) and blended over the backdrop with each layer's blend mode — so intersections and blend modes in
depth order are exact. Depth of field: per plane, a bokeh kernel of the iris (sides, rotation, roundness, aspect,
fringe) gathered over row prefix sums, with highlight boost, at up to eight blur levels. The CPU reference
(`compositeClassicCPU`) is the oracle of the GL renderer.

**Advanced 3D** (After Effects' Advanced 3D): real geometry rasterised with a depth buffer and 4× MSAA. Layers are
quads covering their picture (corner pins included); text and shape layers with Geometry Options (Extrusion Depth,
Bevel Style none / angular / concave / convex, Bevel Depth, Hole Bevel Depth) are extruded solids whose outline is
traced from the layer's own picture (marching squares at 50 % alpha with sub-pixel edges, Douglas–Peucker, nesting →
outlines and holes, earcut caps, bevel rings along the profile, walls coloured from just inside the outline), so any
font, stroke or animator extrudes exactly where its 2D picture is. Shading: Lambert + GGX (Smith visibility, Schlick
Fresnel), roughness `1 − Specular Shininess`, Metal tints the highlight, Reflection Intensity / Sharpness reflect the
environment. Shadows are shadow maps (spot: perspective; parallel: orthographic over the scene; point: six 90° faces)
in one depth atlas, filtered by Shadow Diffusion (PCF), darkened by Shadow Darkness; Accepts Shadows "Only" is a shadow
catcher. An environment light lights from its equirectangular image (a blurred mip along the normal), reflects it
(mip by roughness) and can be the background. Opaque pixels draw first in stack order, transparent ones far → near
without depth writes. Depth of field is a screen-space gather over the nearest surface's depth with iris-polygon taps.

**3D model layers**: `.glb` / `.gltf` (embedded data) / `.obj` media; the engine prober validates them with the
shared parser (`parseModel`); the layer is always 3D; Advanced 3D draws the model's primitives (base colour factor and
texture, metallic / roughness, emissive, alpha mode) fitted to half the frame height around the frame centre in layer
space, then moved by the layer's Motion and 3D transform. Classic 3D draws no models (snapshot warning
`THREE_D_MODEL_CLASSIC`, as After Effects requires Advanced 3D for models). The parser allows 64 million vertex and
index values per model; the total is computed from accessor counts over the scene's nodes before anything is decoded,
so a small mesh shown by many nodes is refused at once instead of after decoding up to the allowance
(`packages/project/test/three-d-hostile.test.ts`).

**3D Camera Tracker.** A `camtrack` job runs the `jasper-camtrack` child process: ffmpeg decodes the span at an
analysis size (960 px, Detailed Analysis 1440 px), OpenCV.js tracks Shi–Tomasi corners frame to frame (pyramidal LK
with a forward–backward check, a RANSAC fundamental matrix per step, re-detection away from live features), and the
ported solver solves the camera: keyframes by parallax, a two-view initialisation (essential matrix by 8-point RANSAC,
or a homography decomposition for flat scenes), incremental resection and triangulation, sparse Levenberg–Marquardt
bundle adjustment (Schur complement, Huber IRLS), focal-length search (log scan + golden section) for Fixed Angle of
View, per-frame focal lengths with a smoothness prior for Variable Zoom, a pure-rotation tripod model that Auto
Detect keeps when it explains the tracks as well, optional radial distortion (k1, k2) in two passes, then every frame
resected. Feature tracks are cached by media, span and analysis mode, so a re-solve (deleted points, other settings)
skips tracking. The solve is stored in a canonical space; `solveMapping` maps it into the sequence: without a ground
plane the first solved camera becomes the default camera at `(w/2, h/2, −zoom)` and one solve unit = `zoom` px; with
Set Ground Plane and Origin the plane of the chosen points becomes the horizontal plane through the frame centre.
Create Camera writes a one-node camera keyed on every frame (position, orientation, zoom for Variable Zoom); Create
Text / Solid and Camera adds a 3D layer lying in the plane of the selected points (Target Size). The tracked clip must
be drawn centred, unrotated, not animated (refused otherwise: the camera's principal point is the frame centre).

**Exports.** 3D runs need the 3D renderer: the planner sends them to the Remotion path with a named blocker; previews
and exports use the same renderer, so the export is what the monitor shows. Layer bake never bakes 3D layers.
Interchange pre-renders 3D layers (and reports 3D placement, cameras and lights when it does not).

## 3. Usage

- **3D layers:** Clip ▸ 3D Layer, or the cube checkbox in Effect Controls ▸ Motion; Properties ▸ 3D Layer / Material
  Options; `set_3d_layer` / `set_3d_transform` / `set_material`.
- **Cameras / lights:** File ▸ New ▸ Camera… / Light…, Graphics ▸ New Layer, Project panel ▸ New Item; Clip ▸ Camera
  Settings… / Light Settings…; the Camera tool (C) orbits, pans (middle / Shift) and dollies (right / wheel) the active
  camera; `add_camera`, `camera_settings`, `move_camera`, `add_light`, `light_settings`.
- **Views:** View ▸ Switch 3D View (Front F10, Custom View 1 F11 — Alt+F11 in browsers, Active Camera F12 — Alt+F12),
  Switch to Last 3D View, Reset 3D View, Create Camera from 3D View; the chip on the Program monitor.
- **Renderer:** Sequence ▸ 3D Renderer ▸ Classic 3D / Advanced 3D / Draft 3D; `set_3d_renderer`. Geometry Options show
  for text and shape layers under Advanced 3D.
- **Models:** import a `.glb`, `.gltf` (embedded) or `.obj`, place it; switch the sequence to Advanced 3D.
- **3D Camera Tracker:** select a video clip ▸ Clip ▸ Track Camera (or the clip's context menu). The Properties
  section shows progress, then Method Used and Average Error; the Program monitor shows the track points (click /
  Shift-click to select; right-click for Create Text and Camera, Create Solid and Camera, Create Camera, Set Ground
  Plane and Origin, Delete Selected Points — deleting solves again). MCP: `track_camera`, `get_camera_tracker`,
  `create_tracked_camera`, `set_tracker_ground`, `delete_track_points`.

## 4. Verified behaviour

Machine: shared 32-core Linux host under heavy load (load average 16–21 from other agents); numbers are measured with
the commands given.

- **Model / commands:** `pnpm vitest run packages/project/test/three-d-*.test.ts` — scene evaluation (defaults equal
  2D Motion, cameras / lights, runs), Classic CPU reference, commands with refusals and invariants / repair, camera
  tracker (the created camera projects every track point to within 0.05 px of where the footage shows it, Create Text
  lies in the points' plane within 10⁻³ rad, ground points land on y = h/2), extrusion (closed solids, outward
  normals, bevel insets), models (glTF node transforms, materials, OBJ).
- **Classic GL = CPU:** `packages/compositions/test/three-d-gl.test.ts` (headless Chrome, SwiftShader): flat,
  intersect + blend modes, orbit camera, orthographic view, lights + shadows + transmission, Dissolve, depth of
  field; pixels off by more than 3 code values ≤ 0.4 % per scene.
- **Advanced 3D:** `packages/compositions/test/three-d-advanced.test.ts`: unlit scenes match the Classic CPU reference
  except at multisampled edges (≤ 3–6 % of pixels off by > 6); the caster's shadow map darkens the floor (no pixel
  lighter); an extruded ring covers > 15 % more pixels than the flat one with lit walls in the fill colour; environment
  background ahead / reflection behind; depth of field keeps the focused layer's contrast and divides the far one's by
  > 3; a lit OBJ cube shows three shades; GGX highlight.
- **Remotion renders (export path):** `REMOTION_E2E=1 pnpm vitest run packages/compositions/test/three-d-render.e2e.test.ts`
  — runs, a run split by a 2D layer, camera + spot light + shadow match the CPU reference (< 1 % pixels off by > 6);
  Advanced 3D with extruded text renders its walls and agrees with Classic on placement.
- **Camera solver accuracy** (`apps/engine/test/camtrack-solve.test.ts`, synthetic scenes, 0.1 px tracking noise):
  Fixed Angle of View focal within 3 % and path within 2 % of its length, rotation within 0.3°; Specify Angle exact
  focal; Variable Zoom focal within 6 % per frame; tripod pan detected (Method Used Tripod Pan, centres fixed); flat
  scene detected (Mostly Flat Scene); lens distortion k1 −0.06 recovered in (−0.09, −0.03). Runtime under load: 27 s for
  40 frames × 260 points (Fixed), 45 s with lens distortion.
- **Camera tracker end to end** (`apps/engine/test/camtrack-job.test.ts`, the ray-cast dolly plate through ffmpeg,
  OpenCV.js and the child process): 534 feature tracks, 501 solved points, 60 / 60 frames, focal 558.4 px vs 560
  (0.3 %), path within 5 %, average error 0.25 px; 88 s for 60 frames at 640×360 (tsx, loaded host); re-solve from the
  cache; cancel kills the process; refusals.
- **Interchange:** `packages/interchange/test/three-d.test.ts`. **Engine models:** `apps/engine/test/three-d-models.test.ts`.
- **Historical real-app evidence:** §8 records the run and screenshots from the former 3D browser tour.

Camera path accuracy means the maximum residual after the least-squares best similarity, divided by the full
authored path length. The synthetic suite fits solved frames; the plate suite fits every returned frame. Rotation
accuracy compares each path relative to its first frame. For the straight, constant-speed fixtures, the test oracle
uses our independently derived [rank-one specialization](../test-cleanup/camera-metric-correction.md), without
production alignment helpers or copied upstream code. [Umeyama (1991)](https://web.stanford.edu/class/cs273/refs/umeyama.pdf)
identifies the least-squares similarity objective; the scalar derivation is our own.

## 5. Comparison with the references

- **EffectCraft** (`render/three_d`, `track/camtrack`): Classic 3D, the bokeh DOF, scene evaluation and the camera
  solver are ports with the same algorithms; the GL renderer follows `classic3d.wgsl` with data textures instead of
  storage buffers. Our feature tracker uses OpenCV.js (LK + fundamental RANSAC) instead of the Rust tracker. EffectCraft
  has an advanced renderer (`three_d/adv`) that we did **not** port: our Advanced 3D (rasteriser, GGX, shadow maps,
  environment, extrusion from the picture's outline, glTF / OBJ) is our own.
- **After Effects:** names, defaults and ranges follow Adobe's documentation (§7). Differences: our Advanced 3D draws
  layers with Normal blending (warned: `THREE_D_ADVANCED_BLEND`; Classic 3D keeps blend modes), shadows are opaque (no Light Transmission in Advanced; warned), the depth of field of
  Advanced 3D is a screen-space gather (no highlight boost / fringe), model units are fitted to half the frame height
  (After Effects' import size is undocumented), extrusion follows the picture's outline (After Effects extrudes glyph
  outlines — ours includes strokes and effects drawn into the picture).

## 6. Limits

- Transitions are refused on 3D layers (`clip.set3d` and `transition.add` refuse; default transitions skip with
  `W_TRANSITION_3D`); animate Opacity instead.
- Classic 3D: shadows come only from planes of the same run; at most 32 fragments per pixel; corner-pinned planes get
  their DOF linearised; no motion blur of 3D layers.
- Nested sequences are planes (their 3D layers are not collapsed into the parent's scene).
- Per-character 3D text animators are drawn inside the text layer's plane (flattened), not as separate planes.
- Advanced 3D: no blend modes between 3D layers, no Light Transmission, no Reflection Rolloff, screen-space DOF with ≤ 96
  taps (large radii are grainy), fill colour forced opaque on extruded faces. On the 8-bit path (no §9 feature in the
  sequence) environment irradiance is a blurred mip and bevels of Bevel Style can self-intersect on very thin strokes
  (miter offsets): bevel bands do not.
- Environment lights take images and Radiance `.hdr`. `light.settings` also accepts a video id, which the image loader
  cannot read: the render refuses. The Environment section offers images and HDRs only.
- Metal needs something to reflect: a physical surface with no environment light reflects the neutral studio. Model layers do
  not: they stay lit by the sequence's lights.
- Models keep their own materials: `threeD.setSurface` refuses them, and metallic-roughness and normal textures are not read.
- Backplates and outside bevels have round joins: an iso-line of a distance field has no miter.
- Transmission refracts what is opaque behind it, in screen space: a glass solid does not see another glass solid, and
  rays that leave the frame clamp to its edge.
- Iridescence is two-beam interference at three wavelengths, not a spectral integration.
- Models: no animations, skins, morph targets, second UV sets, Draco / meshopt, external `.gltf` files (refused: use
  `.glb`), OBJ materials (`.mtl` not read: one neutral material).
- 3D Camera Tracker: the clip must be centred, unrotated, not animated; no "Render Track Points" in the output; no
  Null objects (Jasper has no null layers: Create Text / Solid and Camera only); speed changes on the tracked clip are
  followed through the media frames it shows but the solve itself is of the media; the solver is a TypeScript port
  (a few × slower than native: ≈ 1–1.5 s per frame on a loaded host).
- Fallback preview without HTML-in-Canvas has no depth sort, lights or DOF; renders refuse instead of approximating.
- Program monitor: a *video* clip below a 3D run is captured from its `<video>` element by the run's HTML-in-Canvas
  scope; in the headless Chrome of the e2e runs that capture paints black (the same happens under a GL blend-mode
  scope of keyframes-blend, so it is the shared capture path, not the 3D renderer). Renders (export, stills) draw
  video as images and are correct (`three-d-render.e2e.test.ts` › "a 2D video below a 3D run"). Not fixed here.

## 7. Sources (Adobe documentation and references)

Formulas of §9: GGX prefiltering, Karis, *Real Shading in Unreal Engine 4* (2013); solid-angle mip selection, Křivánek and
Colbert, *Real-time Shading with Filtered Importance Sampling* (2008); environment BRDF fit, Karis, *Physically Based Shading
on Mobile* (2014); tone curves, the ACES fitted RRT+ODT (Narkowicz; the three.js constants), AgX (Troy Sobotka, Benjamin
Wrensch's fit), Khronos PBR Neutral (the Khronos specification), the hue-preserving mode Pachislop's `punch`; shoulder resolve,
Karis, *Tone mapping* (2013); thin film, Born and Wolf; Radiance format, Ward, *Real Pixels* (Graphics Gems II, 1991);
distance propagation, Danielsson, *Euclidean distance mapping* (1980).
Assumptions, undocumented: glint knee, detail size and tail are Pachislop's; the 45 % stop of bevel rings is Pachislop's;
the 6-pixel point size of glints was chosen by looking at frames.

- After Effects User Guide: 3D layers, 3D layer properties and Material Options, Cameras, lights and points of
  interest, 3D views and the camera tools, Advanced 3D renderer, Extruded text and shape layers (Geometry Options),
  Image-based (environment) lights, Import and use 3D models, Track 3D camera movement (3D Camera Tracker effect:
  Shot Type, Horizontal Angle of View, Solve Method, Method Used, Average Error, Detailed Analysis, Track Point Size,
  Target Size, Create Camera / Text / Solid, Set Ground Plane and Origin, Delete Selected Points) — helpx.adobe.com
  (`/after-effects/using/3d-layers.html`, `/cameras-lights-points-interest.html`, `/tracking-3d-camera-movement.html`,
  `/advanced-3d-renderer.html`). Where Adobe does not document a value (model import scale, the exact DOF of Advanced
  3D), the choice is ours and named above.
- Hartley & Zisserman, *Multiple View Geometry* (2nd ed.); Triggs et al., *Bundle Adjustment — A Modern Synthesis*
  (2000); Umeyama (PAMI 1991); Walter et al., *Microfacet Models for Refraction* (GGX, 2007); Karis, *Real Shading in
  Unreal Engine 4* (2013); the glTF 2.0 specification (Khronos).

## 8. Historical real-app run

The command below records the original validation; its browser tour has since been removed.

`E2E_PORT=49380 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/three-d.spec.ts` against the built app (Chrome with
`--enable-features=CanvasDrawElement`), screenshots in `test-results/three-d-*.png`:

1. Clip ▸ 3D Layer on the card and the Effect Controls 3D switch on the floor: one "3D Layer" step each; the floor
   rotated 80° intersects the card on the Program monitor (wireframes and axis gizmo on top).
2. File ▸ New ▸ Camera… / Light… (dialogs, OK): the monitor draws through the moved two-node camera, lit.
3. The 3D view chip ▸ Custom View 1 changes the picture; back to Active Camera.
4. Sequence ▸ 3D Renderer ▸ Advanced 3D + a text layer with Extrusion Depth 60 / convex bevel: extruded "JASPER"
   with lit walls, intersecting the card.
5. Export (Auto → Remotion path, the plan names the 3D blocker): 120 frames at 1080p in 2.3 min (SwiftShader, loaded
   host); the frame at 0.5 s shows the same picture as the monitor (`test-results/three-d-export.png`).
6. 3D Camera Tracker on `camtrack-dolly.mp4`: Clip ▸ Track Camera → "Track Camera" + "Solve Camera" in ≈ 1.5 min;
   Properties ▸ 3D Camera Tracker shows "Solved: 501 track points", Method Used Typical, Average Error 0.25 pixels;
   the track points sit on the footage's features; Shift-click three floor points shows the target; Create Text and
   Camera adds a camera keyed on every frame and a 3D text lying on the floor (`three-d-camtrack-*.png`).

Bugs found and fixed by these runs: the preview did not redraw a run when only 3D values changed (the effect key now
fingerprints cameras, lights, world matrices and materials); a member whose run moved to another bottom track never
delivered again (one shared hub per composition); exports hung on static run members (3D taps deliver every frame);
the camera tracker section looped on an unstable store selector.

## 9. 3D titles (spec 19 §9)

Everything here is Advanced 3D, in one renderer. A sequence that uses none of it stays on the 8-bit path and draws what it
always drew, to the pixel; `advancedNeedsFloat` (shared by the renderer's decision, `snapshotGlNeeds` and the planner) is
the one place that says which is which.

**Pipeline.** Scene linear on a multisampled `RGBA16F` target, transparent where nothing is drawn. Each sample goes through
an invertible shoulder so the hardware resolve averages about what the tone map will show (`hdrCompress`, `EXPAND_FS`). Then
resolve, expand, optional Mitchell downsample (`Sequence3D.supersampling`), depth of field, glints, and the composite: tone
map the scene, add what glass transmitted, put both over the backdrop in linear light, encode to the signal. **The backdrop
never enters the scene**: it does not go through the tone curve, and where nothing is drawn it passes through to the last
bit. A float target that is not there refuses with `THREE_D_NEEDS_FLOAT`: a chip in preview, a plan blocker and a job refusal
in export (`gl-needs.ts`, `webgl-refusal.ts`), `cancelRender` as the backstop. It never degrades.

**Geometry.** Solids are built from the traced outline, never from text. Band rings are a shrinking wavefront (`waveOf`): a
traced outline has a tiny edge at every antialiased corner, and Pachislop's clamp, right for font outlines, stops both ends
of a collapsing edge and leaves a spike. Here the edge leaves the front and its neighbours meet. A ring keeps its vertex
count, merged vertices coincide, so strips stay quads. Each vertex still stops at 45 % of the way to the opposite side, so
hairlines and CJK narrow the bevel instead of folding it. Offsets for plates and outside bevels are iso-lines of a distance
field over the polygon (exact near it, propagated by Danielsson's sweeps): that gives union, closed counters and no
self-intersection without a boolean library, so `clipper2-ts` is not needed. Budgets: 2 M grid nodes, `MAX_SOLID_QUADS`
ring × station products; past them outlines coarsen, so a hostile picture cannot allocate gigabytes.

**Caching.** A picture is delivered every frame, so `picture.version` says nothing. A solid is keyed by a hash of the alpha
and the evaluated `SolidGeometry`; the GPU copy lives as long as the mesh object. Camera, lights, materials, tone mapping and
exposure change uniforms and the material table, never a buffer (`solidBuilds`, tested). An animated bevel width does rebuild.

**Surfaces.** A mesh vertex stores its slot (`SLOT_FACE`, side, back, six bands, two per plate). A table of 8 texels per slot
holds each surface at the frame, so one draw call shades every surface. Absent surfaces fall back to `material.pbr`, then to
Material Options. Relief and flakes are in layer pixels, resolution independent; their antialiasing width comes from depth,
because derivatives are unstable on a glyph cap's sliver triangles.

**Transmission** (TL-074, TL-080). After opaque and transparent passes the scene is resolved, tone mapped and composited over
the backdrop into a mipped target; glass then reads it at the point its refracted ray leaves the solid, and writes a second
attachment that bypasses the tone curve, so a clear pane shows the backdrop as it is. This is the only route for footage
refracted behind a title: look glass (§5.1 of the spec) stays self-contained and refracts its own fill.

**Environments** (TL-075). `.hdr` media are their own kind, `hdri`: a browser cannot show them. The prober decodes the whole
file with the renderer's reader (fuzzed; dimensions validated before anything is allocated; 16K × 8K at most), and decoding
reduces by box factors as it goes, so an 8K file costs 134 MB. In the renderer every environment becomes the same thing: a
2048 × 1024 `RGBA16F` map whose levels hold GGX prefilters at fixed roughnesses, and a cosine-convolved irradiance. Procedural
presets are `GLSL_TL_ENV`, the chunk looks use (TL-038), by the same names, rendered once into the map. Maps are cached by
key, six at most.

**Glints** (TL-077). See the comment at `renderGlint`. Every step is continuous in the highlight's position: a soft knee, a
grid locked to sequence pixels, a tent at every mip step, a point detector that a line of light cannot pass. The test turns a
title in steps of 0.15° and bounds the largest change of total glint energy. It measures energy, not each star, so a star
that moved while the total held would pass; a control with Pachislop's 2×2 box measured 1.2 % against the tent's 1.0 %, so the
test does not separate the two and the tent is a small gain, not the cause of the stability.

**Determinism.** Frames are pure functions of the document and frame. A render holds until pictures, models and HDRs are in.
A model or HDR that is gone refuses with `THREE_D_ASSET_MISSING`: a plan blocker first, `cancelRender` as the backstop. Prefilter
sampling is a fixed Hammersley set.

**Cost** (TL-078). 3D stays on the Remotion path; `costClassOf` gives `3d` or `3d-heavy` (transmission, glints, inflate,
supersampling) and `COST_CLASSES` the words. The UI says so before a clip turns 3D, once, and in the 3D Title section; agents
get `costClass` in `get_3d_scene`.

**Gizmo** (TL-079). Arcs per axis and a free-rotate ring, sized to 60 % of the layer's larger side on screen, 44 to 260 px
(`gizmo.ts`). One undo step per drag, keys when animated.

### Usage

Properties ▸ 3D Title on a 3D text or shape layer (Advanced 3D): surface, material preset, bands, inflate, plates, tone
mapping, exposure, glints. Effect Controls ▸ 3D Title has every number with a stopwatch. Environment lights: Properties ▸
Environment. MCP: `set_3d_surface`, `set_3d_geometry`, `edit_bevel_bands`, `edit_backplates`, `set_3d_renderer`, `add_light`.

### Addresses

| Path | What |
|---|---|
| `["clip", id, "threeD", "surface", <surface>, <value>]` | `<surface>`: `base`, `face`, `side`, `back`, a band id, `<plateId>-face`, `<plateId>-side` |
| `["clip", id, "threeD", "band", <bandId>, "width" \| "depth" \| "curve" \| "profile" \| "segments"]` | |
| `["clip", id, "threeD", "plate", <plateId>, <value>]` | |
| `["clip", id, "threeD", "geometry", "inflate", "height" \| "smoothness"]` | |
| `["scene3d", sequenceId, "exposure" \| "glintThreshold" \| …]` | Keys in sequence time |

### Measured

Machine: 8-vCPU EPYC VM, 15 GB, no GPU (Chrome 156, SwiftShader), shared with other agents. Load average 2 to 9 during the
measured runs below, up to 75 earlier, when only correctness was checked.

| What | Result | Rerun |
|---|---|---|
| Program (Player) against a Remotion still: gold title, environment preset, ACES, a keyed roughness; frames 0 and 45 | SSIM 1.000 both, frames 0 and 45 differ (SSIM 0.974) | `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/three-d-title.e2e.test.ts` (frames in `test-results/three-d-title-e2e`) |
| Razor cut at frame 30 against the uncut clip, frame 45 | identical (SSIM 1.000) | same |
| Glint stability: 8 steps of 0.15° | largest step of total glint energy 1.0 % of the mean (control with a 2×2 box: 1.2 %) | `pnpm exec vitest run packages/compositions/test/three-d-title-gl.test.ts -t "glints hold still"` |
| A moving camera, a material and an environment change | 0 solids built (a bevel change: 1) | `… -t "builds no geometry"` |
| Frame cost, 1920 × 1080, gold title with a band, 4× MSAA, read back each frame | first frame 29.2 s (shaders, environment prefilter, solid), then 7.0 s; glass 14.8 s; glints 20.9 s | `THREE_D_PERF=1 pnpm exec vitest run packages/compositions/test/three-d-title-gl.test.ts -t "cost at 1080p"` |
| Contact sheet of twenty looks | inspected: `/tmp/title-looks/sheets/three-d.png` at the time of writing | `THREE_D_SHEET=<file> … three-d-title-gl.test.ts -t "contact sheet"` |

A first cost run reported 140 ms per frame: it timed only the submission of GL work, as the foundation's first figures did. The
timing now reads a pixel back after each frame. Nothing was measured on a GPU.

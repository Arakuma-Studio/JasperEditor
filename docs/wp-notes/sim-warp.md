# wp `sim-warp` — particles, simulations, mesh and brush warps, Puppet

Branch `feat/sim-warp` (parity program). Ports: [`licenses/ported/sim-warp.md`](../../licenses/ported/sim-warp.md)
(EffectCraft `effects/src/{sim,sim2,sim3,card3d,distort,distort2,distort3,distort4}.rs`, `effects/src/puppet/`).
Authoring guide of the framework this builds on: [fx-transition-framework.md](fx-transition-framework.md).

## 1. What exists now

| Feature | Where |
|---|---|
| 18 Simulation effects + Card Wipe (Transition category) + 9 Distort effects, one family file | `packages/project/src/registry/fx/simulation-warp.ts` → `simulation-warp/*.ts` |
| fx framework: draw passes (instanced, generated vertex shader, blend over / add / max / min / replace), data textures (`{texels}` uniforms → RGBA32F), `rgba32f` pass targets, GPU bitonic sort, CPU pixels of image params (`gpu.cpuPixels`), `FxFrameContext.instanceKey / pixels`, `FxPlanContext.structures` (Puppet, layer masks) | `packages/project/src/registry/fx/shader.ts`, `glsl/data.ts`, `simulation-warp/sort.ts`, `packages/compositions/src/fx/{host,stage,plan,pixels}.ts` |
| Stepped simulations: 60 steps/s, checkpoint cache, params per step (`paramsAt`) | `simulation-warp/core.ts` (`SimCache`, `simKey`, `paramsAtStep`) |
| New param type `mesh` (flat number list, keyframable, interpolated number by number; no expressions) | `schema/common.ts` (`MeshValueSchema`), `registry/effects.ts`, `registry/properties.ts`, `commands/handlers/param.ts` |
| Puppet model: `EffectInstance.puppet {meshes, pins}`; ids `pms_` (mesh), `ppn_` (pin); INV-016 + repair `drop-puppet` | `schema/puppet.ts`, `invariants.ts`, `ids.ts` |
| Puppet engine: outline from alpha, constrained Delaunay mesh, ARAP solve (Igarashi 2005), Starch weights, Overlap depths | `packages/project/src/puppet/{mesh,arap,model}.ts` |
| Pin properties are animatable properties `["puppetPin", pinId, prop]` (stopwatch, keys, graph, expressions as `puppet.<pinId>.<prop>`) | `registry/properties.ts`, `commands/handlers/{param,keyframe}.ts`, `expressions.ts`, `packages/expressions/src/{world,bind}.ts` |
| Commands: `liquify.stroke`, `liquify.reset`, `meshWarp.setVertex`, `meshWarp.reset`, `puppet.addMesh / updateMesh / removeMesh / addPin / removePins / renamePin / movePins / setPinKeys` | `commands/{schemas,handlers}/sim-warp.ts` |
| Web: Effect Controls ▸ Puppet (Pin tool + kind, mesh Density / Expansion / Triangles, pin groups with their property rows), Liquify tool row (brush on/off), `mesh` param row (status + Reset) | `apps/web/src/simwarp/{PuppetList,store}.tsx`, `panels/effectControls/{items.ts,EffectControlsPanel.tsx}`, `panels/properties/controls/PropertyRow.tsx` |
| Web: Program monitor tools — Puppet mesh + draggable pins + Pin tool clicks, Liquify brush (circle cursor, one stroke per drag), Mesh Warp vertex and tangent handles | `apps/web/src/simwarp/{WarpOverlay,register}.tsx` |
| MCP: `get_puppet`, `add_puppet_pins`, `move_puppet_pins`, `record_puppet_pins`, `remove_puppet_pins`, `liquify_stroke`, `set_mesh_warp_vertex` + `SIM_WARP_GUIDE` | `apps/mcp/src/tools/sim-warp.ts` |
| Tests | §6 |

## 2. Catalogue (After Effects name → ours)

After Effects' CC (Cycore) effects are under neutral names (no "CC"); EffectCraft's ids are `ec.sim.*`. Param counts
include our Random Seed where After Effects has one.

| After Effects | Ours | Params (ours / EffectCraft) | Kind |
|---|---|---|---|
| CC Particle World | `jasper.particle-world` Particle World | 61 / 30 | stepped 3D particles, own Effect Camera, Grid & Guides, floor |
| CC Particle Systems II | `jasper.particle-systems` Particle Systems II | 33 / 21 | stepped 2D particles |
| CC Mr. Mercury | `jasper.mercury` Mercury | 25 / 23 | stepped blobs → shaded metaballs |
| Particle Playground | `jasper.particle-playground` | 91 / 92 | stepped: Cannon, Grid (dots / text), Layer Exploder, Particle Exploder, Gravity, Repel, Wall, Property Mapper (27 targets, 5 operators) |
| Shatter | `jasper.shatter` | 60 / 60 | stepped 3D pieces (Bricks, Glass, Hexagons, Squares, Triangles, Custom map), force spheres, gradient, extrusion, camera, lights |
| Card Dance | `jasper.card-dance` | 53 / 53 | closed form, 3D cards from gradient layers |
| CC Pixel Polly | `jasper.pixel-polly` | 11 / 10 | closed form 3D polygons |
| Card Wipe | `jasper.card-wipe` (category Transition) | 44 / — | closed form 3D cards |
| CC Ball Action | `jasper.ball-action` | 9 / 8 | balls, GPU-sorted |
| CC Scatterize | `jasper.scatterize` | 5 / 4 | |
| CC Hair | `jasper.hair` | 20 / 20 | instanced strands |
| Foam | `jasper.foam` | 36 / 36 | stepped (30 fps) bubbles, flow map, popping |
| Wave World | `jasper.wave-world` | 35 / 35 | stepped height field, ground map, producers |
| Caustics | `jasper.caustics` | 28 / 28 | per-pixel refraction + caustic light |
| CC Rainfall, Snowfall, Bubbles, Drizzle, Star Burst | `jasper.rainfall`, `snowfall`, `bubbles`, `drizzle`, `star-burst` | 14 / 14, 19 / 19, 8 / 7, 15 / 14, 7 / 6 | closed form in the vertex shader |
| Bezier Warp | `jasper.bezier-warp` | 13 | Coons patch draw pass, fwidth anti-aliasing |
| Mesh Warp | `jasper.mesh-warp` | 4 | Bézier patches, keyframable Distortion Mesh |
| Liquify | `jasper.liquify` | 15 | keyframable displacement mesh, 10 tools, freeze mask |
| Puppet | `jasper.puppet` | 1 + pins | ARAP mesh deformation |
| Displacement Map, Optics Compensation, Polar Coordinates, Reshape, Smear | `jasper.displacement-map`, `optics-compensation`, `polar-coordinates`, `reshape`, `smear` | 8, 6, 2, 7, 8 | per-pixel / mask-driven |

Not added because they already exist: Magnify, Turbulent Displace (`premiere-stylize-distort-generate`). Every
EffectCraft Simulation entry (`docs/effects.md` § Simulation, 18 effects) has a counterpart above.

Particle World specifics: animations Explosive, Direction Axis, Cone Axis, Viscouse (After Effects' spelling), Twirl,
Twirly, Vortex, Fire, Jet Sideways, Fractal Omni, Fractal Uni; floor None / Bounce / Ice / Glue; 19 particle types
(Line, Shaded / Faded / Darkened Sphere, Bubble, Star, Tri / Quad / Motion Polygon, Cube, Tetrahedron, Textured Disc
/ Square / QuadPolygon (texture = a media param or the layer), five Lens types that refract the layer); birth / death
size and colour, size variation, max opacity, Opacity Map and Color Map (birth-to-death curves, custom 5-colour map),
Volume Shade, transfer modes (Composite, Screen, Add, Black Matte…), Grid & Guides, Effect Camera (distance, rotation,
FOV), depth cue with fog colour.

## 3. Design

**Everything is a GPU shader effect** of the existing declarative framework, so preview, render-frame and every
export path run the same code (§5). What the framework lacked, added here (documented in shader.ts):

- *Draw passes* (`ShaderPass.draw: {vert, vertices, instances, blend}`): instanced triangles with an empty VAO and a
  generated vertex shader (`FX_VERTEX_PRELUDE`: `fx_emit`, perspective-correct `fx_emitW`, `fx_cull`, layer ↔ canvas
  helpers). Particles, strands, pieces, cards, the Bezier Warp patch and the Puppet triangles are draw passes.
- *Data textures*: a uniform `{texels: Float32Array, key?}` becomes an RGBA32F `sampler2D` (1024 texels a row; LRU of
  32 by content hash); shaders read records with `fx_texel` / `fx_texelGrid`. Particle states, piece records, meshes
  and displacement grids travel this way. `rgba32f` pass targets (nearest) keep simulation state on the GPU where it
  is per-pixel (Wave World, Caustics).
- *GPU bitonic sort* (`sort.ts`): painter's order of pieces and balls by depth without a CPU readback.
- *CPU pixels* (`gpu.cpuPixels: ['param']`): effects whose maps decide geometry (Shatter's custom map groups, Wave
  World's ground, Particle Playground's layer maps) read the image's pixels in TS (`ctx.pixels(param)`, ≤ 1024 px,
  loaded with `delayRender` in renders). Video maps are not read on the CPU (decision 6).
- *Structures* (`FxPlanContext.structures`): the resolved Puppet and the layer's masks (as layer-px polylines) reach
  `uniforms` / `padding` — Reshape, Smear, Liquify's freeze and Particle Playground's masks use them.

**Determinism (seek = play).** Closed-form effects (weather, cards, Pixel Polly, Caustics, distortions) are functions
of (params, time, seed). Stepped effects (Particle World / Systems II, Mercury, Playground, Shatter, Foam, Wave World)
step at a fixed 60 steps/s (Foam 30) from the clip start with the params of each step (`paramsAt`, so animated
params act at their time), and keep checkpoints every 60 steps (`SimCache`, thinned beyond 96) keyed by
`instanceKey` — a hash of the instance's params, keys, Puppet data and the clip's timing. Rendering frame N computes
the same state whether reached by playing or by seeking; random numbers are index hashes of (seed, particle, step),
never `Math.random`. The seed is the framework's per-clip, per-instance seed (`fxSeed(clipId, fxId, Random Seed)`), so
Random Seed changes the run and two clips with the same settings do not rain identically.

**Mesh params.** Mesh Warp's and Liquify's Distortion Mesh is a `mesh` param: a flat list of numbers whose layout the
effect defines (`meshes.ts`), keyframable like any param (keys interpolate component-wise; lists of different
lengths hold). Mesh Warp stores per vertex the position and four tangent offsets, layer-normalised. Liquify stores a
displacement grid of 128 cells on the layer's long side with displacements **in cells** (`LIQUIFY_VERSION` 2), so the
same mesh is valid at every resolution the layer is drawn at (proxies, downscaled previews, smaller renders); a
backward map (output p shows source p + d). Expressions are refused on `mesh` params (they are data, not values).

**Puppet.** The instance carries `puppet: {meshes, pins}` (optional field, no schema bump). A mesh is an outline
(layer-normalised polygon; absent = the layer box) plus seed, Density, Expansion and Triangles; the triangulation is
derived and cached (outline → expand by Expansion → triangle size from Triangles × 2^((Density − 50) / 25) →
interior points → Delaunay → boundary recovery). A pin sits at a rest point on a mesh and has animatable Position
(Position / Advanced pins), Scale and Rotation (Advanced / Bend), Amount and Extent (Starch), In Front and Extent
(Overlap). Each frame the pins are resolved (`render/scene.ts`) and the ARAP solve (similarity step + fitting step,
Igarashi et al. 2005; Starch adds rigidity weights around its pins; Bend / Advanced pins constrain the local frame)
deforms the mesh; Overlap pins order triangles front to back (`triangleDepths`) and the draw pass maps the source
through the deformed triangles in that order. Outside every mesh nothing is drawn (After Effects); without meshes the
layer passes through. The first pin on a layer outside every mesh makes a mesh: in the UI and through MCP from the
image's alpha outline under the click when the clip is a still with transparency (`alphaOutline`), else the box.

## 4. Usage

- Effects panel ▸ Simulation / Distort, or `apply_commands effect.add {effectId: "jasper.particle-world"}`; all params
  are in Effect Controls with stopwatches. Simulations need no setup: Particle World starts emitting at the centre.
- **Puppet**: add Puppet, select it in Effect Controls (its header), tick *Pin tool* and pick the kind (Position /
  Advanced / Bend / Starch / Overlap), click on the Program monitor. The mesh is drawn; drag pins (tool off or on) to
  deform — a key when the pin's Position stopwatch is on. Pin groups in Effect Controls rename / delete pins and show
  their properties with stopwatches and keyframes. Mesh Density / Expansion / Triangles edit the mesh.
- **Liquify**: add Liquify, pick the Tool, Brush Size / Pressure, select the effect, tick *Paint with the brush on the
  Program monitor*, drag. One drag = one undo step; with the Distortion Mesh stopwatch on the stroke keys the
  current time. *Reset* on the Distortion Mesh row clears it. Freeze Area Mask picks one of the layer's masks.
- **Mesh Warp**: set Rows / Columns, select the effect, drag the grid vertices; the selected vertex shows its four
  tangent handles.
- Agents: `SIM_WARP_GUIDE` in the server instructions; `get_puppet` → `add_puppet_pins` (first pin traces the PNG's
  alpha) → `record_puppet_pins` / `move_puppet_pins`; `liquify_stroke {points (layer px), tool, size, pressure}`
  (repeat a point to hold the brush there); `set_mesh_warp_vertex {column, row, position, tangents}`.

No default keyboard shortcuts were added (Premiere has no Puppet / Liquify tools; After Effects' Ctrl+P pin tool
would collide with Premiere's defaults), so the keymap is unchanged.

## 5. Export

GPU shader effects export through the hybrid layer bake (ARCHITECTURE D-35, [wp-m2-layer-bake.md](wp-m2-layer-bake.md)):
the layer is rendered by the same compositions in the render browser and overlaid by the native builder; without a
bake renderer the planner routes the export to Remotion. Nothing here is CPU-only, so there is no planner blocker to
add. Image maps referenced by params (`{mediaId}`) are part of the bake key. Two bugs found by exporting and fixed:

- a clip whose only animation was Puppet pins counted as **static** (`isStaticClip` in `render/scene.ts` and
  `isStaticLayer` in `apps/engine/src/layer-bake/layer.ts` only looked at params), so masters froze the pins at the
  first frame while render-frame (one frame) looked right — both now count pin keys and expressions; regression test
  in `sim-warp-commands.test.ts` (“animated pins are re-evaluated every frame”);
- Liquify meshes were in layer px with a grid derived from the box, so a layer drawn at another size read a
  mismatched grid — now cells (above).

## 6. Verified behaviour (measured)

- `packages/compositions/test/fx-sim-warp-gl.test.ts` (headless Chrome WebGL2, `--maxWorkers=2`): 29 passed, 1
  skipped (the opt-in gallery). Per effect: compiles, no NaN / non-finite pixels, determinism (two renders identical;
  seeded effects change with the seed and are stable for one seed; animated ones change over time; stepped ones give
  the same frame N after seeking as after playing), characteristic pixels (particles leave the producer and fall with
  gravity, pieces fly from the force sphere, cards rotate, Caustics brightens focal areas, Polar Coordinates maps the
  top row to the centre, Displacement Map shifts by the map, Mesh Warp / Puppet / Bezier Warp at rest ≈ identity
  within ≤ 3–8 levels, a moved Puppet pin moves its side while the other holds…).
- `packages/project/test/sim-warp-commands.test.ts`: 11 passed (strokes, vertices, pins with undo / redo and
  refusals; keys when animated; invariants and repair; ARAP and triangulation; every Liquify tool; resolution
  independence; alpha outlines; pins in the render scene). `packages/expressions/test/puppet.test.ts`: 2 passed
  (pin properties in the expression world). `apps/mcp/test/sim-warp.test.ts`: 2 passed (all 7 tools, strict
  arguments, refusals); `readme-tools` + `conventions` pass. `packages/project/test/fx-catalogue.test.ts` covers the
  family file.
- `e2e/sim-warp.spec.ts` (built app, `E2E_PORT=49360`): 3 passed — Pin tool clicks add two pins (two History entries,
  one mesh), a pin drag is one “Move Puppet Pins” entry and undo restores it; a Liquify brush drag is one “Liquify”
  entry and undo clears the mesh; a Mesh Warp vertex drag is one “Edit Distortion Mesh” entry and the tangent handles
  show. Screenshots `test-results/e2e-sim-warp-*.png` (looked at: deformed chart under the drawn mesh; the brush
  circle; the grid with handles).
- Real app (dev engine 49361 + web 49362, own appdir): a 14 s sequence with Puppet (alpha-traced figure, two hands
  keyed by `record_puppet_pins`), Liquify (twirl + bloat via `liquify_stroke`), Mesh Warp (`set_mesh_warp_vertex`),
  Particle World, Shatter (View Rendered), Caustics, Card Dance; `render_frame` at several times and `jasper export`
  (native + layer bakes, 1 m 38 s for 420 frames 1080p on the shared machine under load); frames extracted with
  ffmpeg and compared with the render_frame stills: the arm raises over time in the export, Liquify and Mesh Warp
  match, particles and shards are where the previews put them.
- Contact sheets: `SIM_GALLERY=<dir> [SIM_GALLERY_IDS=a,b] pnpm vitest run packages/compositions/test/fx-sim-warp-gl.test.ts -t gallery`
  writes one PNG per effect / setting (26 sheets: particle-world, particle-world-cubes, shatter, shatter-wire, wave-world,
  wave-world-wire, liquify-view…); looked at for this note.

## 7. Comparison with the reference (EffectCraft)

Same algorithms where ported (records in the licence file): particle physics, weather plans, Playground, Shatter
patterns and piece physics, card camera systems, Foam, Wave World, Caustics, the distortions, Liquify brushes, the
puppet mesh and ARAP. Differences: EffectCraft runs its simulations on the CPU per frame (Rust) and composites
sprites in software; here state stepping stays in TS but everything per pixel or per primitive is GLSL (instanced
draw passes, GPU sort), and seeking uses checkpoints instead of re-simulating from 0. Extended beyond the reference:
Particle World's Grid & Guides, Effect Camera, depth cue and full Opacity / Color maps; Liquify's four reconstruction
modes, Clone and a keyframable mesh; Puppet's Bend / Advanced pins, Overlap ordering, keyframable pins with
expressions; Program-monitor tools and MCP tools (the reference has neither for these effects).

## 8. Adobe research (sources)

Adobe's help pages answer automated fetches with HTTP 403 from this machine, so their content was used from prior
knowledge of the documented behaviour, cross-checked against EffectCraft's parameter tables (which mirror After
Effects' parameter names, ranges and defaults):

- After Effects User Guide, *Simulation effects* — https://helpx.adobe.com/after-effects/using/simulation-effects.html
  (Card Dance, Caustics, Foam, Particle Playground, Shatter, Wave World and the CC simulation effects);
- *Distort effects* — https://helpx.adobe.com/after-effects/using/distort-effects.html (Bezier Warp, Displacement
  Map, Liquify, Mesh Warp, Optics Compensation, Polar Coordinates, Reshape, Smear);
- *Animating with Puppet tools* — https://helpx.adobe.com/after-effects/using/animating-puppet-tools.html (Position,
  Starch, Bend, Advanced and Overlap pins, Puppet Sketch, mesh Density / Expansion / Triangles, transparency
  outlines);
- *Transition effects* — https://helpx.adobe.com/after-effects/using/transition-effects.html (Card Wipe);
- T. Igarashi, T. Moscovich, J. F. Hughes, “As-Rigid-As-Possible Shape Manipulation”, SIGGRAPH 2005.

Where the documentation is silent we chose the plausible behaviour and say so in §9.

## 9. Decisions and limitations

1. Neutral names: no “CC”, Mr. Mercury → Mercury; Card Wipe sits under Transition (After Effects' category) but is a
   clip effect, not a timeline transition.
2. Particle World / Shatter / Card Dance use their own Effect Camera; After Effects' “Comp Camera” and “First Comp
   Light” options are not offered (no 3D comp camera here yet — the `three-d` workstream).
3. Effects draw inside the layer box like After Effects (pieces and particles leaving a small layer are cut at its
   edge — the After Effects remedy, a layer the size of the frame or a nest, applies). Distortions that move pixels
   outside (Bezier Warp, Mesh Warp, Puppet, Smear) pad the canvas.
4. Puppet: Puppet's “On Transparent” option is not offered (a mesh is its outline); the Puppet Sketch tool's live
   recording is not in the UI — `record_puppet_pins` / `puppet.setPinKeys` record motions; pins are drawn on the
   monitor only while their effect is focused in Effect Controls.
5. Liquify: a click without moving does not dab (one stroke needs a drag; agents repeat a point); Liquify meshes made
   before `LIQUIFY_VERSION` 2 (only on this branch) read as empty.
6. Maps read on the CPU (Shatter custom map, Wave World ground, Playground layer maps) must be **images**; a video in
   those params is ignored (no map). Particle Playground's Layer Map reads the map at the current frame (no per-particle
   time offset).
7. Drizzle draws at most 4096 drops; Particle World up to its Birth Rate × Longevity with the framework's data-texture
   cap (1 Mi texels).
8. Inner edges between 3D pieces are not anti-aliased (painter's order without MSAA); outer edges are.
9. Shatter pieces cut from transparent areas show no extrusion sides (After Effects shows nothing there either in our
   reading; undocumented).
10. No default shortcuts for the Puppet Pin tool or the Liquify brush (§4).

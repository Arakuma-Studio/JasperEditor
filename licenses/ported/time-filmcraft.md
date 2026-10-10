# Scene Edit Detection options and application (workstream time)

- **Upstream:** https://github.com/storytold/filmcraft (commit `771b614`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** workstream `time`, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/render/src/scene.rs` (`SceneOptions::threshold`) | `packages/project/src/time-remap/scenes.ts` | the 0…100 sensitivity mapped to an absolute threshold (0.45 − 0.33·s there; 0.45 − 0.4·s on effectcraft's measure here) |
| `crates/engine/src/scene_detect.rs` | `packages/project/src/commands/handlers/time.ts` (`clip.applySceneEdits`) | applying results in one undo step: cuts latest-first so the left piece keeps the clip id, linked clips cut too, one subclip per shot in a "<clip> Scenes" bin, clip markers named "Scene Edit" |
| `crates/project/src/lib.rs` (`TimeInterpolation`) | `packages/project/src/schema/sequence.ts` | the three Time Interpolation modes (names and labels) |

Notes: FilmCraft's grid/histogram difference was measured against effectcraft's measure on our test reel (precision
0.67 vs 1.0 with the flash test, `packages/project/test/time-scenes.test.ts`); only its options and application were
ported. FilmCraft renders Optical Flow as frame blending; ours is a real motion-compensated interpolation.

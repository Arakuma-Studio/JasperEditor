# Photoshop-style warp meshes

- **Upstream:** https://github.com/SethRobinson/Patchy (commit `3f7c560e50f218c19eb9f22dbd76416a867999e7`)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2026 Seth A. Robinson
- **Ported by:** Title Looks, spec 19 TL-110, 2026-11-02

| Upstream path | Our path | What |
|---|---|---|
| `src/core/warp_mesh.cpp` | `packages/project/src/registry/fx/text-warp/mesh.ts` | the 15 warp style meshes, Bézier evaluation, degree elevation, axis swap of the vertical orientation and the horizontal and vertical distortion, C++ → TypeScript |

Notes: the style constructions and the distortion are unchanged, and `packages/project/test/text-warp.test.ts` compares the
port with the output of the upstream code, compiled at the pinned commit (`fixtures/patchy-warp-meshes.json`). Not ported:
the lattice and homography code for smart objects, and the bilinear cell inversion: our warp is a forward mesh of the
picture. New in the port: `warpSurface` (normalised to the layer box, re-centred, Pachislop's rule) and the continuation of
the map past the box along its tangent. The spec names this upstream in TL-003.

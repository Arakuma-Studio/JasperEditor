# Polygon triangulation with holes (earcut), ported by the `three-d` workstream

- **Upstream:** https://github.com/mapbox/earcut (v2.2)
- **Licence:** ISC
- **Copyright:** Copyright (c) 2016, Mapbox
- **Ported by:** three-d workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `src/earcut.js` | `packages/project/src/three-d/triangulate.ts` | Ear clipping on a linked vertex ring, hole bridging, local intersection cures and splits (Advanced 3D extrusion caps) |

Notes: ported to TypeScript without the z-order curve hashing (outlines here have at most a few thousand points) and
without the `dim` / deviation helpers.

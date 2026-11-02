# Pachislop text warp framing and vertical text rules

- **Upstream:** https://github.com/SafEight/pachislop (commit `dd952d0`)
- **Licence:** LicenseRef-Pachislop
- **Copyright:** Copyright (c) 2026 SafEight
- **Ported by:** Title Looks, spec 19 TL-110 and TL-111, 2026-11-02

| Upstream path | Our path | What |
|---|---|---|
| `src/text/warp.ts` | `packages/project/src/registry/fx/text-warp/mesh.ts` | re-centring the warped frame on the box, so a bend does not drift the layer |
| `src/text/layout.ts` | `packages/project/src/text-writing.ts` | the idea of tate-chu-yoko on runs of half-width characters, here limited to 1 to 3 characters by a new rule |

Notes: Pachislop warps glyph outlines of a still and lays vertical text out itself from font tables. Here Chromium does all
shaping (`writing-mode`, `vert`, `text-combine-upright`) and the warp moves the rendered picture, so neither of those parts
was ported, and a warp animates.

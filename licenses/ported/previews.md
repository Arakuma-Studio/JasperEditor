# Code ported by the `previews` workstream (render-bar segments, content hashes, playback cost model)

- **Upstream:** https://github.com/storytold/filmcraft (commit `771b614ad4c3fbefda5d668ce4384504b8c13f6d`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** previews workstream, 2026-10-08

| Upstream path | Our path | What |
|---|---|---|
| `crates/render/src/preview.rs` | `packages/project/src/render/previews.ts` | Segments cut at every clip / transition edge, a content hash relative to the segment start (ids, names, markers excluded), the per-frame playback cost estimate (decode by codec × pixels, layer path, effect tiers, transitions) with the yellow / red threshold, audio segments for Render Audio |
| `crates/engine/src/previews.rs` | `apps/engine/src/previews/service.ts`, `apps/web/src/panels/timeline/model/renderbar.ts` | Preview store (files named by hash, `.part` then rename), Render Effects In to Out / In to Out / Selection / Render Audio selection rules, Delete Render Files, the bar states (green / yellow / red / none) |

Notes: the hash is not computed from the project model as upstream does, but from Jasper's render snapshot (what every
renderer consumes), normalised, so features added later are covered without listing them; ids are kept where the
renderers seed noise from them; expressions make a segment hash the whole expression world and its absolute
position. The cost constants were re-chosen for the browser Program monitor (WebCodecs decode, WebGL effects,
HTML-in-Canvas captures). Preview files are I-frame-only H.264 (upstream: ProRes QuickTime), playable by the browser.
The 128-bit hash is the public-domain `cyrb128` construction, not upstream's FNV-128.

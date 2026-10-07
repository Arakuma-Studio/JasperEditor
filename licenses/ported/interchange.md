# Code ported by the `interchange` workstream

## FilmCraft

Upstream: FilmCraft — https://github.com/storytold/filmcraft
Licence: MIT OR Apache-2.0
Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors

| Upstream path | Our path | What |
|---|---|---|
| `crates/interchange/src/fcp7.rs` | `packages/interchange/src/fcp7.ts` | Final Cut Pro 7 XML (xmeml) reader/writer: clipitems, files by id, nested sequences, generators, transitions, Basic Motion / Opacity / Time Remap / Audio Levels / Pan filters with keyframes, links, markers, Premiere ticks (extended: bins and master clips, crop, ticks above 2^53, blend modes, channel mapping, hold filters, multiclips) |
| `crates/interchange/src/fcpxml.rs` | `packages/interchange/src/fcpxml.ts` | FCPXML 1.9–1.11 reader/writer: resources, spine and lanes, rational time, timeMap, transform/blend/volume/pan keyframes, compound clips, roles (extended: non-uniform scale, anchor, crop, captions, multicam / mc-clip) |
| `crates/interchange/src/otio.rs` | `packages/interchange/src/otio.ts` | OpenTimelineIO JSON (Timeline.1, Stack.1, Track.1, Clip.1/.2, Gap.1, Transition.1, Marker.2, references, time warps) (extended: the full JasperEditor round trip in `metadata.jasper`) |
| `crates/interchange/src/edl.rs` | `packages/interchange/src/edl.ts` | CMX 3600 EDL: events, drop frame, dissolves, wipes, keys, M2 speed, LOC markers, extended reels, per-track lists (extended: marker colours, timecode guess on import) |
| `crates/interchange/src/ale.rs` | `packages/interchange/src/ale.ts` | Avid ALE writer (extended: import, extra columns kept) |
| `crates/interchange/src/comp.rs` | `packages/interchange/src/comp.ts` | The mob-style composition model shared by AAF and OMF (fillers, clips, overlapping transitions, sources, gain) |
| `crates/interchange/src/essence.rs` | `packages/interchange/src/essence.ts` | Audio ranges an AAF / OMF export references (handles, per clip, whole media) |
| `crates/interchange/src/wav.rs` | `packages/interchange/src/wav.ts` | WAVE and AIFF containers for embedded / separate audio essence |
| `crates/interchange/src/aaf/{mod,ids,store,read,write}.rs` | `packages/interchange/src/aaf/{index,ids,store,read,write}.ts` | AAF Edit Protocol over structured storage: class/property ids, the property-stream store, reader and writer (extended: the SDK's TopLevel usage code, MetaDictionary index streams, both read) |
| `crates/cfb/src/{lib,read,write}.rs` | `packages/interchange/src/cfb.ts` | Microsoft Compound File Binary reader/writer (v3 / v4 sectors) |
| `crates/interchange/src/omf/{mod,bento,read,write}.rs` | `packages/interchange/src/omf/{index,bento,read,write}.ts` | OMF Interchange 2.0 in a Bento container (label, TOC, references), audio-only compositions, WAVE/AIFF descriptors, embedded media data |
| `crates/interchange/src/xml.rs`, `crates/interchange/src/common.rs` | `packages/interchange/src/xml.ts`, `packages/interchange/src/paths.ts`, `packages/interchange/src/build.ts` | XML reading/writing helpers, file URLs and paths, label colours, gain/dB |
| `crates/interchange/tests/{support,otio,fcp7,fcpxml,edl,aaf_omf,uncarried_clips}.rs` and `src/omf/tests.rs` | `packages/interchange/test/support/{arbitraries,canonical,ir}.ts`, `packages/interchange/test/*.test.ts` | Property round trips (proptest strategies ported to fast-check), fixtures-style tests, uncarried-clip reports, OMF structural checks |

## EffectCraft

Upstream: EffectCraft — https://github.com/storytold/effectcraft
Licence: MIT OR Apache-2.0
Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors

| Upstream path | Our path | What |
|---|---|---|
| `crates/interchange/src/export.rs` (`PrerenderMode`, `prerender_reason`, `plan_prerender`, `Prerendered`) | `packages/interchange/src/prerender.ts`, `packages/interchange/src/jasper-export.ts` (`PrerenderedClip`) | Pre-rendering for timeline export: `unsupported` / `all` / `none`, the per-layer reason a format cannot represent it, the plan, and the substitution of rendered movies (ProRes 4444 with alpha) — adapted from composition layers to sequence clips and per-format capabilities |

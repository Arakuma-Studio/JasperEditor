# Ledger — Premiere port (done)

Status: **done** — merged to `main` and pushed (`origin/main` 69c96e3b, 2026-10-25). This ledger records what was
asked, decided, built and verified.

## 1. What the user asked
1. Read the user's Premiere Pro projects (31 `.prproj` files on their Mac) and decode everything in them.
2. Analyse whether JasperEditor can port them exactly; list what it lacks.
3. Then implement (100 % complete, parallel agents in worktrees, commit progress, merge to main):
   - a persistent, cross-project user font library (upload fonts once, use in every project);
   - an approximation of Red Giant Universe "Slide" with motion blur etc. (research first);
   - map Premiere Pitch Shifter parameters to semitones (no VST hosting);
   - curved spatial paths on effect point params (Transform, Offset…);
   - per-side keyframe interpolation (Ease In / Ease Out, mixed sides);
   - Crop applies in stack order + Crop Edge Feather renders;
   - Premiere-style Link Media: relink one missing file and auto-relink the others found from its folder;
   - Premiere audio crossfade shapes incl. Custom Fade;
   - WMA (and other non-browser audio) playable in the preview.
4. Constraints added during the work: heavy work (tests, builds, servers) must not run on the shared host — use a
   rented VM (shared vCPU, one box only); after merging, fetch remote changes, merge them properly, then push.

## 2. Decoding (done)
- `.prproj` = gzipped XML object graph. A Python decoder (private, git-excluded: `.prproj-analysis/tools/`) exports
  every project to JSON: sequences, tracks, clips (timing, speed, reverse, freeze, nesting, adjustment layers),
  effects with static/keyframed params (After Effects ease model incl. spatial tangents), transitions, text documents
  (UTF-16 JSON and FlatBuffer variants), mask paths, markers, caption tracks/styles, Premiere transcripts (word level),
  audio-plugin state, links and groups. Coverage: 31/31 projects, 461 sequences, 30,055 clips, nothing undecoded.
- Portability analysis (two agents + coordinator spot checks) → the 9 gaps above, plus "can't be exact":
  third-party plug-ins (Sapphire S_Shake, Universe Slide), unverified effect math, no `.prproj` importer.

## 3. Delivered (all on `main`)
| Feature | Branch | Notes |
|---|---|---|
| Schema v8 foundation | feat/premiere-port | v7→v8 migration moves Crop effects listed after others to the front so v7 projects render as before |
| User font library | feat/pp-font-library | TTF/OTF/WOFF/WOFF2/TTC, app-level store, resolution by family/PostScript/full name, Resolve Fonts, MCP tools |
| Smooth Slide (`jasper.smooth-slide`) | feat/pp-universe-slide | Universe Slide approximation (animation presets, dolly, reflection, motion blur + shutter, edge smoothing); FCP7 import mapping |
| Premiere Pitch Shifter mapping | feat/pp-pitch-mapping | Transpose Ratio linear 0.5 + 1.5·n; FCP7 import/export |
| Curved paths on effect points | feat/pp-spatial-points | arc length in layer-box pixels (aspect-correct) |
| Per-side keyframe interpolation | feat/pp-keyframe-sides | AE rule; legacy documents evaluate unchanged |
| Crop in stack order + Edge Feather | feat/pp-crop-order | every render path; feather model is an assumption (undocumented by Adobe) |
| Link Media + auto-relink | feat/pp-link-media | foreign (Windows/UNC/POSIX) paths, folder mapping, relative paths, bounded search |
| Audio crossfades incl. Custom Fade | feat/pp-audio-crossfades | Constant Gain/Power, Exponential, Custom Fade shape/value/symmetry, Custom Start |
| WMA / undecodable audio preview | feat/pp-wma-preview | lossless 32-bit float WAV playback derivative; sample-exact export decode |
| Easing reconciliation | feat/pp-ease-sides | origin/main's keyframe easing feature made per-side aware |

Fixes found during integration: MCP `tools/list` broke on a `z.custom` schema (fixed with strict enums);
`browserDecodesAudio("__proto__")` crash (own-key lookup + regression test).

## 4. Verification (build VM, Hetzner cpx51, 16 shared vCPU)
- Lint, typecheck, build, i18n check, notices, LGPL FFmpeg check: pass.
- Tests: 6,700 passed; 6 failures that also fail on the previous `main` (5 Jasper Synth pinned hashes,
  1 ZIP 128 MiB memory test) — not caused by this work, left alone.
- Playwright e2e: 121 passed, 2 skipped, 0 failed. Remotion render suites for touched areas: 93/93.

## 5. Known limits carried forward
- Smooth Slide and Custom Fade intermediate curves are researched approximations (assumptions in their wp-notes).
- Crop Edge Feather falloff undocumented by Adobe (assumption).
- Effect-point path timing in pixels; whether Premiere times in pixels or normalised units is unverified.
- No `.prproj` importer yet (mapping functions exported for one).
- The 6 pre-existing test failures on `main`.

# Fidelity to Premiere Pro and After Effects

JasperEditor does not measure itself against Adobe software: there is no capture harness, and no test needs
Premiere Pro or After Effects. Fidelity comes from **research during implementation** (AGENTS.md, the parity brief
§3b):

- **Adobe's documented behaviour.** The helpx.adobe.com user guides, effect and parameter references, keyboard
  shortcut lists and release notes. Parameter names, ranges, defaults, units and visible behaviour follow them, or
  do better where Adobe is clearly worse.
- **The reference implementations.** EffectCraft (a clean-room After Effects) and FilmCraft (a clean-room Premiere
  Pro), MIT OR Apache-2.0, and their own fidelity notes. What we port is recorded in [`licenses/ported/`](../../licenses/ported/).
- **Published formulas.** Colour science (ITU-R BT.709 / BT.2020 / BT.2100, ST 2084, ARIB STD-B67, camera log
  white papers), easing and Bézier maths, the EBU R128 loudness definition, blend-mode equations.

Every workstream cites the sources it relied on in its wp-note (`docs/wp-notes/<name>.md`) and says where behaviour
is undocumented and the most plausible choice was made.

## What is measured

What can be measured is measured against **our own oracles**, not against Adobe:

| Oracle | Used for | Where |
|---|---|---|
| ffmpeg / ffprobe | loudness (`ebur128`), PSNR / SSIM of exports, packet and frame tables, decoded frames, fixture generation | `@jasper/testkit` oracle helpers ([testing.md](../testing.md) §Oracles); `JASPER_REQUIRE_ORACLES=1` makes a missing oracle a failure |
| Standards and published values | colour transforms, timecode, caption formats (SCC / CEA-608, EBU STL, TTML), interchange formats (FCP7, FCPXML, OTIO, EDL, AAF, OMF, ALE) | the workstreams' unit and property tests |
| CPU references of GPU code | effects, transitions, masks, blend modes, colour runs | GL tests (headless Chrome on SwiftShader, poisoned scratch targets) |
| Golden frames and fingerprints | regressions of every rendered feature | [testing.md](../testing.md) §Golden frames |

Nothing in this folder claims a numeric "parity with Premiere" score; [`docs/parity.md`](../parity.md) and
[`docs/gaps.md`](../gaps.md) record feature coverage and its evidence.

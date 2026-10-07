# Ported code: caption files, transcripts and text-based editing (wp `captions`)

- **Upstream:** https://github.com/storytold/filmcraft
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** captions workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/captions/src/lib.rs` | `packages/project/src/captions/formats/core.ts`, `packages/project/src/captions/formats/index.ts` | Cue / document model, `snap_to_frames`, `normalize`, format detection, text decoding (BOM, UTF-16, Windows-1252), clock times |
| `crates/captions/src/srt.rs` | `packages/project/src/captions/formats/srt.ts` | Forgiving SubRip reader and writer |
| `crates/captions/src/vtt.rs` | `packages/project/src/captions/formats/vtt.ts` | WebVTT reader/writer: cue ids, settings, `<v>` voices, STYLE/REGION/NOTE blocks |
| `crates/captions/src/cea608.rs` | `packages/project/src/captions/formats/cea608.ts` | CEA-608 character sets, parity, PACs, control codes |
| `crates/captions/src/scc.rs` | `packages/project/src/captions/formats/scc.ts` | Scenarist SCC: channel-1 608 decoder (pop-on, roll-up, paint-on), pop-on scheduler and writer |
| `crates/captions/src/mcc.rs` | `packages/project/src/captions/formats/mcc.ts` | MacCaption MCC: hex abbreviations, SMPTE ST 334-2 CDPs, CEA-708 service 1 writer and decoder |
| `crates/captions/src/stl.rs` | `packages/project/src/captions/formats/stl.ts` | EBU STL (Tech 3264): GSI/TTI blocks, ISO/IEC 6937, extension blocks |
| `crates/captions/src/ttml.rs` | `packages/project/src/captions/formats/ttml.ts`, `packages/project/src/captions/formats/xml.ts` | TTML / IMSC1 / DFXP reader and writer (roxmltree replaced by a small total XML reader) |
| `crates/captions/src/burn.rs` | `packages/project/src/captions/model.ts` (`styleFromVttSettings`), `packages/compositions/src/layers/CaptionsLayer.tsx` | WebVTT `line:`/`align:` placement overrides, caption layout rules (frame-relative size, box, outline, anchor) |
| `crates/captions/tests/roundtrip.rs` | `packages/project/test/caption-formats.test.ts` | Round-trip property tests and reader totality tests (proptest → fast-check) |
| `crates/project/src/caption.rs` (`plain_text`) | `packages/project/src/captions/formats/core.ts` (`plainCaptionText`) | Markup stripping |
| `crates/project/src/transcript.rs` (`normalize_word`) | `packages/project/src/captions/words.ts` (`normalizeWord`) | Word normalisation for search and fillers |
| `crates/edit/src/transcript.rs` | `packages/project/src/captions/sequence-transcript.ts` | Sequence transcript, word at, paragraphs, search, word ranges, pauses, fillers (longest phrase first), filler ranges, merge ranges, caption blocks |
| `crates/edit/src/transcript/tests.rs`, `crates/edit/tests/fixtures/interview.transcript.json` | `packages/project/test/sequence-transcript.test.ts`, `packages/project/test/fixtures/interview.transcript.json` | Deterministic transcript tests and the interview fixture (times converted to seconds) |
| `crates/edit/src/captions.rs` | `packages/project/src/commands/handlers/captions.ts`, `packages/project/test/captions-commands.test.ts` | Caption add (clamped to the next caption), split, merge, set times, trim/move/delete semantics and their tests |

Notes: Rust → TypeScript; times are flicks (705 600 000 / s) instead of ticks; frame arithmetic uses BigInt so it is
exact for every rational rate. In JasperEditor captions are clips on caption tracks that own their words (a
transcript each), so split partitions words by time instead of duplicating the text (the text is duplicated only
when no word boundary lies between the halves, as in FilmCraft). Speech recognition (`crates/speech`) was not ported.

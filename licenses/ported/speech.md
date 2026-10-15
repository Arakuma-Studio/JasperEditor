# Ported code: speech-to-text front end, word timing, VAD and speaker labelling (wp `speech`)

- **Upstream:** https://github.com/storytold/filmcraft
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** speech workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/speech/src/mel.rs` | `apps/engine/src/speech/core/mel.ts` | Whisper log-mel front end (Slaney filterbank, reflect padding, framing, normalisation); the DFT became a mixed-radix FFT |
| `crates/speech/src/whisper/tokenizer.rs` | `apps/engine/src/speech/core/tokenizer.ts` | `tokenizer.json` byte-level BPE decoding, special tokens, language tokens, non-text specials |
| `crates/speech/src/whisper/align.rs` | `apps/engine/src/speech/core/align.ts` (`medianFilter`, `dtw`, `alignTokens`) | Cross-attention normalisation, median filter, DTW token alignment |
| `crates/speech/src/whisper/mod.rs` | `apps/engine/src/speech/core/decode.ts` (`applyFilters`, `repeating`), `apps/engine/src/speech/worker/whisper.ts` | Timestamp rules, suppression, no-speech skip, repetition guard, window/seek loop, language detection |
| `crates/speech/src/vad.rs` | `apps/engine/src/speech/core/vad.ts` (`frameDb`, `vadThreshold`, `tightenWords`) | Energy-based word-bound tightening (30 % floor→speech, ≥ 6 dB, 60 ms minimum) |
| `crates/speech/src/diarize.rs` | `apps/engine/src/speech/core/diarize.ts` | MFCC 1–19 mean/std chunk vectors, average-linkage clustering, small-cluster folding, numbering by first appearance |
| `crates/speech/src/models.rs` | `apps/engine/src/speech/models.ts` | Model store: pinned files, sha256 verification, `.part` downloads, installed/missing bytes |
| `crates/speech/src/lib.rs` (`word_error_rate`) | `apps/engine/test/speech-wer.ts` | Word error rate |
| `crates/speech/src/{vad,diarize,mel,lib}.rs` tests, `crates/speech/src/whisper/{align,mod}.rs` tests | `apps/engine/test/speech-core.test.ts` | Unit tests (synthetic voices, VAD fixture, DTW band, median filter, repetition guard) |

Notes: Rust (candle) → TypeScript on ONNX Runtime (the onnx-community Whisper exports with cross-attention outputs
instead of safetensors); times are 16 kHz samples in the worker and flicks in the model. Additions over the
reference: English-only models, beam search, temperature fallback, conditioning on previous text, OpenAI's word
duration heuristics and punctuation merging (see `speech-openai-whisper.md`), voice-aware seek, word-bound repair at
pauses and growth into adjacent voice, an exact speaker-count hint, translation, sequence-mix transcription.

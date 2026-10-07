# Ported code: Whisper decoding and word-timestamp algorithms (wp `speech`)

- **Upstream:** https://github.com/openai/whisper
- **Licence:** MIT
- **Copyright:** Copyright (c) 2022 OpenAI
- **Ported by:** speech workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `whisper/decoding.py` (`ApplyTimestampRules`, `SuppressBlank`, `SuppressTokens`, `BeamSearchDecoder`, `MaximumLikelihoodRanker`) | `apps/engine/src/speech/core/decode.ts`, `apps/engine/src/speech/worker/whisper.ts` (`decodeBeam`) | Logit filters and timestamp rules; beam search (patience 1) and ranking by mean log-probability |
| `whisper/transcribe.py` (`transcribe`, `decode_with_fallback`) | `apps/engine/src/speech/worker/whisper.ts`, `apps/engine/src/speech/core/decode.ts` (`parseSegments`, `compressionRatio`) | Seek loop, segment parsing, temperature fallback (compression ratio 2.4, log-probability −1, no-speech 0.6), conditioning on previous text, seek to the last word with word timestamps |
| `whisper/timing.py` (`find_alignment`, `merge_punctuations`, `add_word_timestamps`) | `apps/engine/src/speech/core/align.ts` | Word boundaries from DTW jumps, punctuation merging, median-duration capping, segment boundary corrections |
| `whisper/tokenizer.py` (`LANGUAGES`, `split_to_word_tokens`, `split_tokens_on_unicode`) | `apps/engine/src/speech/core/tokenizer.ts`, `apps/web/src/speech/model.ts` (`WHISPER_LANGUAGES`) | Word splitting (no-space languages), the language list |

Notes: Python/PyTorch → TypeScript on ONNX Runtime; no weights are included (models download on demand, see
`apps/engine/src/processing/models.json` `speech`). Hallucination-silence skipping and `clip_timestamps` were not ported.

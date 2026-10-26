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
| `whisper/transcribe.py` (`word_anomaly_score`, `is_segment_anomaly`, the `hallucination_silence_threshold` block, `initial_prompt` / `carry_initial_prompt` prompt assembly; v20240930) | `apps/engine/src/speech/core/hallucination.ts` (`wordAnomalyScore`, `isSegmentAnomaly`, `silenceThresholdCut`), `apps/engine/src/speech/worker/whisper.ts` (`initialPromptTokens`, prompt assembly) | Spec 16 SG-011/SG-012: anomalous segments surrounded by silence are dropped and decoding resumes at them; the initial prompt (`" " + prompt.strip()`) starts the running text, as OpenAI's `initial_prompt` (carry_initial_prompt off) |

Notes: Python/PyTorch → TypeScript on ONNX Runtime; no weights are included (models download on demand, see
`apps/engine/src/processing/models.json` `speech`). `clip_timestamps` was not ported. Spec 16 (2026-10-25) ported the
hallucination-silence skipping and the initial prompt; the BPE encoder for the prompt follows the byte-level BPE
definition (GPT-2's pre-tokenizer pattern and merge ranks from the model's `tokenizer.json`), written from the
algorithm description, not from tiktoken's or Hugging Face tokenizers' code.

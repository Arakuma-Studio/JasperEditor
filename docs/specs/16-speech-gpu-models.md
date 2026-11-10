# Spec 16: Speech-to-text on the GPU, model catalogue and robustness

Status: specified 2026-10-25; implementation tracked in [`docs/ledgers/premiere-workflow.md`](../ledgers/premiere-workflow.md).
Owner wp-note: [`docs/wp-notes/speech.md`](../wp-notes/speech.md) (extended). [`ARCHITECTURE.md`](../ARCHITECTURE.md) and
[`AGENTS.md`](../../AGENTS.md) win over this spec. Related: [spec 14](14-transcript-cleanup.md) TC-003 (verbatim prompt,
segment scores, hallucination guard).

## 0. Background (measured 2026-10-25; private research `.prproj-analysis/research/whisper`, 53 configurations)

Material: 5 clips (525.5 s, 1,594 words) of the user's Spanish voice-over + silence/noise clips; references from the
projects' transcripts/scripts (≈ 1–1.5 WER points are reference artefacts). onnxruntime-node 1.30.0, JasperEditor
`main` 71c86ba, language forced `es`.

| Machine | Config | RTF | WER | Hallucinated words on silence |
|---|---|---|---|---|
| M4 Max CPU | tiny / base / small / medium / large-v3-turbo (beam 5) | 0.082 / 0.125 / 0.291 / 0.777 / **0.256** | 19.6 / 12.0 / 6.8 / 4.7 / **3.4 %** | 0 / 37 / 4 / 36 / 7 |
| M4 Max | turbo, WebGPU (Metal) encoder + CPU decoder | **0.215** | 3.4 % | 7 |
| Build VM 16 vCPU | small / medium t8 / turbo t8 | 0.467 / 0.955 / 0.454 | 6.8 / 4.7 / 3.4 % | |
| RTX 3060 | turbo CUDA, greedy | **0.155** | 3.3 % | 1 |
| RTX 3060 | turbo CUDA, beam 5 | 0.696 | 4.1 % | |
| RTX 3060 | medium CUDA, beam 5 (decoder on GPU) | 2.68 (slower than CPU) | 3.6 % | |
| any | int8/q8 exports | — | 75.5 % (x86 turbo-q8); 140 of 186 words lost after silence (Mac q8 decoders) | |

Findings: turbo is both the most accurate and (on CPU) faster than small; medium is slower and less accurate than
turbo; full large-v3 has no ONNX export with cross-attention outputs (no word timing); int8 exports are broken or
slower; fp16 is fine on GPU but 2–4× slower on CPU. onnxruntime-node keeps tensors on the device between calls only
for WebGPU, so a CUDA decoder copies the KV cache every step — the GPU wins for the encoder (turbo encoder per 30 s:
8.4 s CPU → 0.29 s CUDA on the 3060 box; 1.9 s → 0.88 s WebGPU → 0.34 s CoreML on the Mac), and for the decoder only
with CUDA + greedy. CoreML recompiles at every load (410–844 s) and the Node binding can't cache it. CUDA ships for
Linux x64 only, needs CUDA 13 + cuDNN 9 (driver ≥ 580) and the provider library is never installed under pnpm.
Robustness bugs: hallucinated text in silence carried forward and moved onto speech; model downloads restart from
zero on any error.

## 1. Goals
- G1 Use the GPU automatically when it helps (per model part), fall back to CPU silently-but-visibly, never fail a job
  because a GPU path is unavailable.
- G2 Ship the models that win on quality and speed (large-v3-turbo), recommend per machine, drop the ones that lose.
- G3 Make transcription robust: no hallucinations in silence, resumable downloads, validated catalogue.
- G4 Tell humans and agents what device runs and how fast it is (measured vs estimated).

## 2. Requirements

### 2.1 Execution providers
- SG-001 A cached **provider probe** (engine, at first speech use and on demand) per platform: macOS WebGPU → CPU;
  Linux x64 CUDA (provider library present + a probe session loads + CUDA 13/cuDNN 9 found) → WebGPU → CPU; Windows
  WebGPU → DirectML → CPU. CoreML is not used until the binding can cache compiled models (document; re-evaluate on
  ORT upgrades). Result reported in `features.speech` capabilities: `{providers: [{id, available, reason?, device?}],
  chosen: {encoder, decoder}}`.
- SG-002 Providers chosen **per session**: encoder on the best GPU provider; decoder on CPU, except CUDA + greedy when a
  ≈ 1 s calibration on the loaded model shows the GPU decoder faster (store the calibration with the probe).
- SG-003 Fallbacks: session creation failure → retry that session on CPU and record the reason; a GPU error mid-job →
  retry the job once on CPU, then fail with the original error; job result + Jobs panel show the device used and any
  fallback reason. Worker failures propagate as job errors (AGENTS §0).
- SG-004 WebGPU device-resident outputs workaround: if device-resident binding is used, use a second session for
  cached decoder steps (binding bug in 1.30.0); covered by a test.
- SG-005 Threads: per OS, capped by performance-core count and 8 (measured: 10 slower than 4 on the M4 Max; 8 beats 4
  on the 16-vCPU VM).
- SG-006 CUDA delivery on Linux: the engine downloads the ONNX Runtime CUDA provider package (MIT; pinned version +
  sha256; resumable, verified) into the app dir on request ("Enable NVIDIA GPU" in Preferences) — not bundled, never
  in git; the NVIDIA runtime (CUDA 13 + cuDNN 9) is detected, not shipped (proprietary licences, AGENTS §2.5), with
  clear install guidance when missing; `pnpm` config is not changed to run onnxruntime-node's postinstall.
- SG-007 DirectML DLLs shipped inside onnxruntime-node: confirm their licence terms before relying on them on Windows;
  record in the wp-note and `THIRD_PARTY_NOTICES.md` if shipped; if the terms don't fit the allowlist, Windows uses
  WebGPU → CPU only.
- SG-008 The upscaler's existing CUDA probe reuses SG-001 (one probe implementation).

### 2.2 Decoding
- SG-010 Default decoding greedy with temperature fallback (thresholds as OpenAI's `transcribe.py`: compression ratio
  2.4, avg logprob −1.0, no-speech 0.6); "Best (slower)" = beam 5. Exposed in the Generate Transcript dialog,
  Preferences and MCP (`transcribe {accuracy: 'standard'|'best'}`).
- SG-011 Hallucination guards (shared with spec 14 TC-003): skip windows with no voiced frames; reset the previous-text
  prompt after silence ≥ 2 s; drop (don't move) words lying entirely in non-speech; OpenAI's hallucination-silence-
  threshold heuristic (2 s); known-phrase filter; `splitAtPauses` must never move a word across a silence into speech.
  Regression test from the measured failure ("Gracias por ver el vídeo" over silence). Speech after long digital
  silence is never skipped: windows don't start with ≥ 2 s of silence, decoding never jumps over voice after ≥ 2 s
  of silence, and spans with ≥ 2 s of voice but no word are decoded again alone (bounded; `guard.recovered`).
- SG-012 Initial-prompt support (tokenizer encode) for verbatim prompting (spec 14 TC-003).
- SG-013 JS hot spots: `logSoftmax`, beam top-k, mel FFT, `applyFilters` optimised (typed arrays, partial sort); target
  ≥ 2× less JS time per token on the build VM (measure before/after under the bench lock).
- SG-014 Long files: stream decoding window by window instead of decoding the whole file and full mel into memory;
  memory bounded (measure 1 h file peak RSS).

### 2.3 Model catalogue and downloads
- SG-020 Catalogue: add `whisper-large-v3-turbo` (fp32, `onnx-community/whisper-large-v3-turbo_timestamped` pinned
  revision + sha256 per file, external-data files) and `whisper-large-v3-turbo-fp16` (GPU-only recommendation; requires
  fp16 tensor handling); keep `whisper-small`, `whisper-base`, `whisper-tiny` (+ `.en` variants); do not add medium or
  any int8/q8 export. Licences recorded (MIT upstream).
- SG-021 Recommendation per machine (shown as "Recommended for this computer"): GPU available → turbo (fp16 when the
  GPU provider is CUDA/WebGPU and VRAM ≥ 6 GB, else fp32); CPU-only with ≥ 16 GB RAM and ≥ 8 cores → turbo fp32; else
  small. Default model for new installs follows the recommendation.
- SG-022 Downloads: HTTP Range resume of `.partial` files, retries with backoff, per-file sha256 verification,
  `install.json` written atomically; progress with bytes; cancellable; never restart a large file from zero after a
  transient error.
- SG-023 Catalogue validated with zod at load (AGENTS §0); bad entries refused with a visible error.

### 2.4 UI and MCP
- SG-030 Preferences ▸ Transcription: each model row shows size, languages, "Runs on: <device> (<provider>) · N
  threads", speed "≈ x min per 10 min of audio (estimated)" until a job ran, then "(measured, last run)"; Processor:
  Automatic / CPU / GPU (with the reason when GPU is unavailable); Accuracy: Standard / Best; Enable NVIDIA GPU (Linux)
  with download and status.
- SG-031 MCP: `list_speech_models` includes recommendation, device, measured speed; `transcribe` accepts `device:
  'auto'|'cpu'|'gpu'` and `accuracy`; `engine_status` shows the probe.
- SG-032 i18n English + Spanish.

### 2.5 Validation
- SG-040 Tests: provider probe/fallback with a fake ORT binding (session creation failure, mid-job GPU error → CPU retry
  → result notes the fallback); calibration logic; silence-gap fixture (no words in the gap, none lost after it);
  download resume (interrupted server fixture); catalogue zod validation; CPU-vs-GPU text parity on the build VM
  (WebGPU via software adapter if available, else documented as skipped) — never claim GPU paths passed without a GPU.
- SG-041 Measurements recorded in `docs/wp-notes/speech.md` (machine, load, model, provider, RTF, WER) — the table in
  §0 plus post-implementation reruns on the build VM (CPU) and, when available, a GPU box.

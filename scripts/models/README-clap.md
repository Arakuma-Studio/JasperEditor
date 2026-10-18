# CLAP export for Describe-it search (developer tool)

`export-clap.py` turns LAION's `laion/larger_clap_general` (Apache-2.0, revision
`ada0c23a36c4e8582805bb38fec3905903f18b41`) into the ONNX graphs the engine's `jasper-clap` worker loads (spec 12 P6-E14,
wp-note "Phase 6 → WP-E9"). The app never runs Python (ARCHITECTURE D-40) and never runs this script.

## Run it (on a build machine, not in the app)

```bash
python3 -m venv venv && . venv/bin/activate        # or uv venv
pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1
pip install transformers==4.46.3 onnx==1.19.1 onnxruntime==1.30.0 ml_dtypes librosa==0.10.2.post1
R=ada0c23a36c4e8582805bb38fec3905903f18b41
mkdir laion && for f in config.json preprocessor_config.json tokenizer_config.json special_tokens_map.json \
  vocab.json merges.txt pytorch_model.bin; do
  curl -fL -o laion/$f https://huggingface.co/laion/larger_clap_general/resolve/$R/$f; done
python3 scripts/models/export-clap.py --src laion --out out --sounds apps/engine/sounds/starter
```

It refuses a `pytorch_model.bin` that is not the pinned one (sha256 `314eb00c…`), exports the audio tower
(`input_features [b,1,1001,64]` → `audio_embeds [b,512]`) and the text tower (`input_ids`, `attention_mask` →
`text_embeds [b,512]`), both L2-normalised, and writes into `out/`:

| File | What |
|---|---|
| `clap-audio.graph.onnx`, `clap-text.graph.onnx` | The graphs **without weights**: every initializer is ONNX external data (offset, length) into the unmodified `pytorch_model.bin` next to it. These are the files in `apps/engine/models/clap/` (byte-identical across runs). |
| `clap-{audio,text}.fp32.onnx` | Self-contained fp32 exports (not used by the app). |
| `clap-{audio,text}.int8.onnx` | Dynamic int8 quantisation (not used: lossy, see the wp-note). |
| `clap-export.json` | Tool versions, sha256 and size of every file, the parity numbers (`apps/engine/models/clap/clap.provenance.json` is this file). |
| `parity-vectors.json` | Reference log-mels, token ids and PyTorch embeddings for `apps/engine/scripts/check-clap.ts`. |

The script fails unless the graph-only and fp32 exports match PyTorch (cosine ≥ 0.999999 on every test sound and text,
one at a time and in a padded batch). Then check the engine's own front end and ONNX Runtime for Node against it:

```bash
mkdir model && cp out/clap-*.graph.onnx laion/vocab.json laion/merges.txt model/ && ln laion/pytorch_model.bin model/
pnpm exec tsx apps/engine/scripts/check-clap.ts out/parity-vectors.json model --model model
```

(`ln`, not a symbolic link: ONNX Runtime refuses external data outside the model's folder.) When the graphs change,
update the sha256 and sizes in `apps/engine/src/processing/models.json` (`sound`) and the sidecars.

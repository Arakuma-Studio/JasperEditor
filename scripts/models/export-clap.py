#!/usr/bin/env python3
"""Exports the CLAP model laion/larger_clap_general to ONNX for Describe-it search (spec 12 P6-E14, WP-E9).

Developer tool only: the app never runs Python (ARCHITECTURE D-40) and never runs this script. It produces the ONNX
graphs the engine's `jasper-clap` worker loads with ONNX Runtime (D-24). See scripts/models/README-clap.md.

Source (pinned):
  laion/larger_clap_general @ ada0c23a36c4e8582805bb38fec3905903f18b41 (Apache-2.0, LAION)
  pytorch_model.bin sha256 314eb00cce6ad68d25237b8446b659ccdb136ed4672c1bca470f142f72455026 (776 444 665 bytes)

Outputs (in --out):
  clap-audio.graph.onnx, clap-text.graph.onnx
      The graphs WITHOUT the model weights: every weight is an ONNX external-data reference into the unmodified
      pytorch_model.bin (its tensors are stored uncompressed and contiguous in the zip, so an offset and a length
      name each one). The app downloads pytorch_model.bin from LAION's own repository (pinned revision, sha256) and
      places it next to these graphs. These graphs are what apps/engine/models/clap/ bundles.
  clap-audio.fp32.onnx, clap-text.fp32.onnx
      Self-contained fp32 exports (weights inside).
  clap-audio.int8.onnx, clap-text.int8.onnx
      onnxruntime.quantization quant_pre_process + quantize_dynamic (QInt8 weights, per tensor) of the fp32 exports.
  clap-export.json
      Provenance: tool versions, sha256 and size of every file, the parity measurements.
  parity-vectors.json
      HF feature-extractor log-mels and tokenizer ids for a few inputs (to check the engine's TypeScript front end).

Inputs and outputs of the graphs:
  audio  input_features float32 [batch, 1, 1001, 64] (ClapFeatureExtractor, truncation rand_trunc: slaney mel, 48 kHz,
         10 s repeat-padded) -> audio_embeds float32 [batch, 512], L2-normalised
  text   input_ids int64 [batch, tokens], attention_mask int64 [batch, tokens] (RoBERTa BPE, <s> ... </s>)
         -> text_embeds float32 [batch, 512], L2-normalised

Parity (the script fails unless every check passes): for every test sound and text, the cosine similarity between the
PyTorch embedding and the ONNX Runtime embedding of the graph-only and fp32 exports is >= 0.999999 (min reported);
the int8 export is measured and reported only (it is lossy: the app does not use it).

Usage:
  python3 scripts/models/export-clap.py --src <dir with the pinned laion files> --out <dir> [--sounds <dir>]
"""
import argparse
import hashlib
import json
import math
import os
import platform
import sys
import zipfile

REPO = "laion/larger_clap_general"
REVISION = "ada0c23a36c4e8582805bb38fec3905903f18b41"
WEIGHTS = "pytorch_model.bin"
WEIGHTS_SHA256 = "314eb00cce6ad68d25237b8446b659ccdb136ed4672c1bca470f142f72455026"
WEIGHTS_BYTES = 776444665
OPSET = 17
FRAMES = 1001
MELS = 64

TEXTS = [
    "glass shattering on concrete",
    "a single clean key press on a mechanical keyboard",
    "a heavy wooden door slamming shut",
    "a soft whoosh of air passing by",
    "a deep cinematic boom with a long tail",
    "a bright metallic ding",
    "rain falling on a tin roof",
    "a dog barking in the distance",
    "footsteps on gravel",
    "a crowd applauding in a large hall",
    "a cartoon boing",
    "an electric spark crackling",
    "paper being crumpled",
    "a camera shutter click",
    "a low rumble of thunder",
    "water dripping into a bucket",
    "a car engine starting",
    "a short digital beep",
    "a riser building tension",
    "a punch hitting a body",
    "birds chirping in a forest at dawn",
    "a typewriter carriage return bell",
    "a coin dropping on a table",
    "wind howling through trees",
    "a balloon popping",
    "a zipper being pulled",
    "a glass clinking against another glass",
    "a sword being unsheathed",
    "a low drone hum",
    "silence",
    "a man speaking",
    "piano music",
    "a",
    "Glass!!! shattering...   on CONCRETE?? 123 — naïve café",
]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def zip_tensor_offsets(path):
    """sha256 of every stored record of a torch zip checkpoint -> (byte offset of its data, length)."""
    out = {}
    with open(path, "rb") as raw, zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.compress_type != zipfile.ZIP_STORED:
                continue
            raw.seek(info.header_offset)
            header = raw.read(30)
            if header[:4] != b"PK\x03\x04":
                sys.exit(f"bad local header for {info.filename}")
            name_len = int.from_bytes(header[26:28], "little")
            extra_len = int.from_bytes(header[28:30], "little")
            data_offset = info.header_offset + 30 + name_len + extra_len
            raw.seek(data_offset)
            data = raw.read(info.file_size)
            out.setdefault(hashlib.sha256(data).hexdigest(), (data_offset, info.file_size))
    return out


def synthetic_sounds(np, sr=48000):
    rng = np.random.default_rng(1234)
    t = lambda s: np.arange(int(sr * s)) / sr  # noqa: E731
    out = {}
    out["sine-440-1s"] = 0.5 * np.sin(2 * math.pi * 440 * t(1.0))
    out["chirp-2s"] = 0.4 * np.sin(2 * math.pi * (100 + 4000 * t(2.0)) * t(2.0))
    noise = rng.standard_normal(int(sr * 0.5)) * np.exp(-np.arange(int(sr * 0.5)) / (sr * 0.05))
    out["noise-burst-0.5s"] = 0.6 * noise / np.max(np.abs(noise))
    clicks = np.zeros(int(sr * 3.0))
    clicks[:: int(sr * 0.25)] = 0.9
    out["clicks-3s"] = clicks
    out["am-tone-10s"] = 0.3 * np.sin(2 * math.pi * 220 * t(10.0)) * (0.5 + 0.5 * np.sin(2 * math.pi * 2 * t(10.0)))
    out["pink-ish-6s"] = np.cumsum(rng.standard_normal(int(sr * 6.0))) * 0.001
    out["very-short-20ms"] = 0.8 * np.sin(2 * math.pi * 1000 * t(0.02))
    out["silence-1s"] = np.zeros(sr)
    return {k: v.astype(np.float32) for k, v in out.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="directory with the pinned laion/larger_clap_general files")
    ap.add_argument("--out", required=True)
    ap.add_argument("--sounds", help="directory of real test sounds (.ogg/.wav), e.g. apps/engine/sounds/starter")
    a = ap.parse_args()

    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    import transformers
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from onnxruntime.quantization.shape_inference import quant_pre_process
    from transformers import ClapFeatureExtractor, ClapModel, RobertaTokenizer

    src = os.path.abspath(a.src)
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    weights = os.path.join(src, WEIGHTS)
    got = sha256(weights)
    if got != WEIGHTS_SHA256 or os.path.getsize(weights) != WEIGHTS_BYTES:
        sys.exit(f"{weights}: sha256 {got} / {os.path.getsize(weights)} bytes, expected the pinned {WEIGHTS_SHA256}")

    torch.manual_seed(0)
    model = ClapModel.from_pretrained(src).eval()
    fe = ClapFeatureExtractor.from_pretrained(src)
    tok = RobertaTokenizer.from_pretrained(src)
    if fe.truncation != "rand_trunc" or fe.padding != "repeatpad" or model.config.audio_config.enable_fusion:
        sys.exit("unexpected feature extractor settings (the engine implements rand_trunc + repeatpad, no fusion)")

    class Audio(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_features):
            e = self.m.get_audio_features(input_features=input_features)
            return torch.nn.functional.normalize(e, dim=-1)

    class Text(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids, attention_mask):
            e = self.m.get_text_features(input_ids=input_ids, attention_mask=attention_mask)
            return torch.nn.functional.normalize(e, dim=-1)

    audio, text = Audio(model).eval(), Text(model).eval()
    paths = {
        "audio.fp32": os.path.join(out, "clap-audio.fp32.onnx"),
        "text.fp32": os.path.join(out, "clap-text.fp32.onnx"),
        "audio.graph": os.path.join(out, "clap-audio.graph.onnx"),
        "text.graph": os.path.join(out, "clap-text.graph.onnx"),
        "audio.int8": os.path.join(out, "clap-audio.int8.onnx"),
        "text.int8": os.path.join(out, "clap-text.int8.onnx"),
    }
    dummy_audio = torch.zeros(2, 1, FRAMES, MELS)
    dummy_ids = torch.tensor([tok("a dog barking")["input_ids"]] * 2, dtype=torch.long)
    dummy_mask = torch.ones_like(dummy_ids)

    def export(folding, audio_path, text_path):
        with torch.no_grad():
            torch.onnx.export(
                audio,
                (dummy_audio,),
                audio_path,
                input_names=["input_features"],
                output_names=["audio_embeds"],
                dynamic_axes={"input_features": {0: "batch"}, "audio_embeds": {0: "batch"}},
                opset_version=OPSET,
                do_constant_folding=folding,
                dynamo=False,
            )
            torch.onnx.export(
                text,
                (dummy_ids, dummy_mask),
                text_path,
                input_names=["input_ids", "attention_mask"],
                output_names=["text_embeds"],
                dynamic_axes={
                    "input_ids": {0: "batch", 1: "tokens"},
                    "attention_mask": {0: "batch", 1: "tokens"},
                    "text_embeds": {0: "batch"},
                },
                opset_version=OPSET,
                do_constant_folding=folding,
                dynamo=False,
            )

    # Unfolded: every weight stays an initializer equal to its checkpoint tensor (the graph-only export points at it;
    # ONNX Runtime folds the transposes when it loads the graph). Folded: the self-contained exports (weights
    # pre-transposed, so the quantiser finds every MatMul weight).
    unfolded = {p: os.path.join(out, f"clap-{p}.unfolded.onnx") for p in ("audio", "text")}
    export(False, unfolded["audio"], unfolded["text"])
    export(True, paths["audio.fp32"], paths["text.fp32"])

    # Graph-only exports: initializers equal to a checkpoint record become external data in pytorch_model.bin.
    offsets = zip_tensor_offsets(weights)
    graph_stats = {}
    for part in ("audio", "text"):
        m = onnx.load(unfolded[part])
        moved = kept = kept_bytes = 0
        for init in m.graph.initializer:
            raw = init.raw_data
            if not raw:
                arr = onnx.numpy_helper.to_array(init)
                raw = arr.tobytes()
            hit = offsets.get(hashlib.sha256(raw).hexdigest()) if len(raw) >= 64 else None
            if hit and hit[1] == len(raw):
                init.ClearField("raw_data")
                for f in ("float_data", "int64_data", "int32_data", "double_data"):
                    init.ClearField(f)
                init.data_location = onnx.TensorProto.EXTERNAL
                del init.external_data[:]
                for k, v in (("location", WEIGHTS), ("offset", str(hit[0])), ("length", str(hit[1]))):
                    e = init.external_data.add()
                    e.key, e.value = k, v
                moved += 1
            else:
                kept += 1
                kept_bytes += len(raw)
        onnx.save(m, paths[f"{part}.graph"])
        os.remove(unfolded[part])
        graph_stats[part] = {"externalTensors": moved, "embeddedTensors": kept, "embeddedBytes": kept_bytes}
    # The graph-only files load their weights from pytorch_model.bin in the same directory (ONNX Runtime refuses
    # external data outside the model's directory, also through a symbolic link): a hard link, else a copy.
    link = os.path.join(out, WEIGHTS)
    if os.path.islink(link):
        os.remove(link)
    if not os.path.exists(link):
        try:
            os.link(weights, link)
        except OSError:
            import shutil

            shutil.copyfile(weights, link)

    for part in ("audio", "text"):
        pre = os.path.join(out, f"clap-{part}.pre.onnx")
        quant_pre_process(paths[f"{part}.fp32"], pre, skip_symbolic_shape=True)
        quantize_dynamic(pre, paths[f"{part}.int8"], weight_type=QuantType.QInt8)
        os.remove(pre)

    # ---- parity -----------------------------------------------------------------------------------------------
    sounds = synthetic_sounds(np)
    if a.sounds:
        import librosa

        for name in sorted(os.listdir(a.sounds)):
            if name.endswith((".ogg", ".wav", ".flac", ".mp3")):
                y, _ = librosa.load(os.path.join(a.sounds, name), sr=48000, mono=True)
                sounds[name] = y[: 48000 * 10].astype(np.float32)
    names = sorted(sounds)
    feats = np.concatenate(
        [fe(sounds[n], sampling_rate=48000, return_tensors="np")["input_features"] for n in names], axis=0
    ).astype(np.float32)
    with torch.no_grad():
        ref_audio = audio(torch.from_numpy(feats)).numpy()
        enc = [tok(t)["input_ids"] for t in TEXTS]
        ref_text = np.concatenate(
            [text(torch.tensor([ids]), torch.ones(1, len(ids), dtype=torch.long)).numpy() for ids in enc], axis=0
        )
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    parity = {}
    for variant in ("graph", "fp32", "int8"):
        sa = ort.InferenceSession(paths[f"audio.{variant}"], opts, providers=["CPUExecutionProvider"])
        st = ort.InferenceSession(paths[f"text.{variant}"], opts, providers=["CPUExecutionProvider"])
        got_a = np.concatenate([sa.run(None, {"input_features": feats[i : i + 4]})[0] for i in range(0, len(feats), 4)])
        got_t = np.concatenate(
            [
                st.run(None, {"input_ids": np.array([ids], np.int64), "attention_mask": np.ones((1, len(ids)), np.int64)})[0]
                for ids in enc
            ]
        )
        # a padded batch must give the same embeddings as one text at a time
        width = max(len(x) for x in enc)
        ids_b = np.array([x + [tok.pad_token_id] * (width - len(x)) for x in enc], np.int64)
        mask_b = np.array([[1] * len(x) + [0] * (width - len(x)) for x in enc], np.int64)
        got_tb = st.run(None, {"input_ids": ids_b, "attention_mask": mask_b})[0]
        cos = lambda x, y: np.sum(x * y, axis=1) / (np.linalg.norm(x, axis=1) * np.linalg.norm(y, axis=1))  # noqa: E731
        ca, ct, cb = cos(got_a, ref_audio), cos(got_t, ref_text), cos(got_tb, ref_text)
        # retrieval agreement: the best text of every sound and the best sound of every text
        sim_ref, sim_got = ref_audio @ ref_text.T, got_a @ got_t.T
        parity[variant] = {
            "audioCosineMin": float(ca.min()),
            "audioCosineMean": float(ca.mean()),
            "textCosineMin": float(ct.min()),
            "textCosineMean": float(ct.mean()),
            "paddedBatchTextCosineMin": float(cb.min()),
            "top1AgreementSoundToText": float(np.mean(sim_ref.argmax(1) == sim_got.argmax(1))),
            "top1AgreementTextToSound": float(np.mean(sim_ref.argmax(0) == sim_got.argmax(0))),
            "maxAbsSimilarityDiff": float(np.max(np.abs(sim_ref - sim_got))),
        }
        print(variant, json.dumps(parity[variant]))
    for v in ("graph", "fp32"):
        p = parity[v]
        if min(p["audioCosineMin"], p["textCosineMin"], p["paddedBatchTextCosineMin"]) < 0.999999:
            sys.exit(f"parity failed for {v}: {p}")
    if min(parity["int8"]["audioCosineMin"], parity["int8"]["textCosineMin"]) < 0.999:
        # Measured, not fatal: the app does not use the int8 export (wp-note "Phase 6 -> WP-E9").
        print(f"note: int8 parity is below 0.999 ({parity['int8']}); the app uses the fp32 weights", file=sys.stderr)

    # Vectors for the engine's TypeScript front end (log-mel and tokenizer), checked by
    # apps/engine/scripts/check-clap-frontend.mjs on the build server.
    vec_names = ["sine-440-1s", "very-short-20ms", "clicks-3s", "am-tone-10s"]
    vectors = {
        "mel": [
            {
                "name": n,
                "samples": sounds[n].tolist(),
                "features": fe(sounds[n], sampling_rate=48000, return_tensors="np")["input_features"][0, 0].tolist(),
            }
            for n in vec_names
        ],
        "tokens": [{"text": t, "ids": tok(t)["input_ids"]} for t in TEXTS],
    }
    with open(os.path.join(out, "parity-vectors.json"), "w") as f:
        json.dump(vectors, f)

    files = {}
    for k, p in sorted(paths.items()):
        files[os.path.basename(p)] = {"sha256": sha256(p), "sizeBytes": os.path.getsize(p)}
    meta = {
        "model": REPO,
        "revision": REVISION,
        "weights": {"file": WEIGHTS, "sha256": WEIGHTS_SHA256, "sizeBytes": WEIGHTS_BYTES, "license": "Apache-2.0"},
        "opset": OPSET,
        "io": {
            "audio": "input_features float32 [batch,1,1001,64] -> audio_embeds float32 [batch,512] (L2-normalised)",
            "text": "input_ids int64 [batch,tokens], attention_mask int64 [batch,tokens] -> text_embeds float32 [batch,512]",
        },
        "graphOnly": graph_stats,
        "files": files,
        "parity": {"sounds": len(names), "texts": len(TEXTS), **parity},
        "tools": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "onnx": onnx.__version__,
            "onnxruntime": ort.__version__,
            "numpy": np.__version__,
        },
    }
    with open(os.path.join(out, "clap-export.json"), "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    print(json.dumps({"files": files, "graphOnly": graph_stats}, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Converts the SPAN 2x super-resolution weights "2xNomosUni_span_multijpg" to ONNX (S07:PST-032).

Provenance (recorded in span-provenance.json next to the output):
  weights  2xNomosUni_span_multijpg.pth by Philip Hofmann, CC BY 4.0 (attribution required)
           https://github.com/Phhofm/models/releases/tag/2xNomosUni_span_multijpg
  network  SPAN (Swift Parameter-free Attention Network, hongyuanyu/SPAN, Apache-2.0), loaded with
           spandrel (chaiNNer-org, MIT)
  export   torch.onnx (TorchScript exporter), opset 17, fp32, input NCHW float32 [0,1] RGB named "input",
           output "output"; batch, height and width are dynamic.

Usage (needs Python with torch, spandrel, onnx, onnxruntime, numpy):
  python3 scripts/models/export-span-onnx.py <out.onnx> [--pth <local .pth>]
The .pth is downloaded from the pinned URL (sha256 checked) unless --pth is given (also checked).
The exported model is verified against PyTorch on a random 64x48 tile and a 256x256 tile
(max |diff| must stay below 1e-4).
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile
import urllib.request

PTH_URL = "https://github.com/Phhofm/models/releases/download/2xNomosUni_span_multijpg/2xNomosUni_span_multijpg.pth"
PTH_SHA256 = "1a981d0a11e2fcbb6cda7ac635f31b97d9903492ba7e4dda09b8be0b274f1ac5"
OPSET = 17


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--pth")
    a = ap.parse_args()

    import numpy as np
    import onnx
    import onnxruntime as ort
    import spandrel
    import torch

    pth = a.pth
    if not pth:
        pth = os.path.join(tempfile.mkdtemp(), "2xNomosUni_span_multijpg.pth")
        print(f"downloading {PTH_URL}", file=sys.stderr)
        urllib.request.urlretrieve(PTH_URL, pth)
    got = sha256(pth)
    if got != PTH_SHA256:
        sys.exit(f"sha256 mismatch for {pth}: {got} (expected {PTH_SHA256})")

    desc = spandrel.ModelLoader(device="cpu").load_from_file(pth)
    if desc.architecture.id != "SPAN" or int(desc.scale) != 2:
        sys.exit(f"unexpected model: {desc.architecture.id} x{desc.scale}")
    net = desc.model.eval()
    for p in net.parameters():
        p.requires_grad_(False)

    x = torch.rand(1, 3, 64, 64)
    kwargs = dict(
        input_names=["input"],
        output_names=["output"],
        opset_version=OPSET,
        dynamic_axes={"input": {0: "batch", 2: "height", 3: "width"},
                      "output": {0: "batch", 2: "height2", 3: "width2"}},
        do_constant_folding=True,
    )
    try:
        torch.onnx.export(net, (x,), a.out, dynamo=False, **kwargs)
    except TypeError:
        torch.onnx.export(net, (x,), a.out, **kwargs)
    model = onnx.load(a.out)
    onnx.checker.check_model(model)
    model.producer_name = "jasper export-span-onnx.py"
    meta = {
        "name": "2xNomosUni_span_multijpg",
        "author": "Philip Hofmann",
        "license": "CC-BY-4.0",
        "attribution": "2xNomosUni_span_multijpg by Philip Hofmann (CC BY 4.0), SPAN architecture (Apache-2.0)",
        "source": "https://github.com/Phhofm/models/releases/tag/2xNomosUni_span_multijpg",
        "scale": "2",
    }
    del model.metadata_props[:]
    for k, v in meta.items():
        e = model.metadata_props.add()
        e.key, e.value = k, v
    onnx.save(model, a.out)

    sess = ort.InferenceSession(a.out, providers=["CPUExecutionProvider"])
    worst = 0.0
    for h, w in ((48, 64), (256, 256), (61, 97)):
        t = torch.rand(1, 3, h, w)
        ref = net(t).numpy()
        got_o = sess.run(None, {"input": t.numpy()})[0]
        if got_o.shape != (1, 3, 2 * h, 2 * w):
            sys.exit(f"bad output shape {got_o.shape} for {h}x{w}")
        worst = max(worst, float(np.abs(ref - got_o).max()))
    if worst > 1e-4:
        sys.exit(f"ONNX output differs from PyTorch by {worst}")

    prov = {
        "model": "2xNomosUni_span_multijpg",
        "onnx": os.path.basename(a.out),
        "onnxSha256": sha256(a.out),
        "onnxBytes": os.path.getsize(a.out),
        "opset": OPSET,
        "precision": "fp32",
        "io": {"input": "NCHW float32 RGB [0,1], dynamic batch/height/width", "output": "NCHW float32 RGB, 2x"},
        "weights": {"url": PTH_URL, "sha256": PTH_SHA256, "license": "CC-BY-4.0", "author": "Philip Hofmann"},
        "architecture": {"name": "SPAN", "code": "https://github.com/hongyuanyu/SPAN", "license": "Apache-2.0"},
        "tools": {"torch": torch.__version__, "spandrel": spandrel.__version__, "onnx": onnx.__version__,
                  "onnxruntime": ort.__version__, "python": sys.version.split()[0]},
        "verifiedMaxAbsDiff": worst,
    }
    with open(os.path.join(os.path.dirname(os.path.abspath(a.out)), "span-provenance.json"), "w") as f:
        json.dump(prov, f, indent=2)
        f.write("\n")
    print(json.dumps(prov, indent=2))


if __name__ == "__main__":
    main()

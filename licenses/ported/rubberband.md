# Rubber Band Library compiled to WebAssembly (the Pitch Shifter's optional `rubberband-r3` engine)

- **Upstream:** https://github.com/breakfastquay/rubberband (tag `v4.0.0`, commit `1d95888bec3ae0a17c0c4af791810d5a63f6bc35`)
- **Licence:** GPL-2.0-or-later
- **Copyright:** Copyright 2007-2024 Particular Programs Ltd.
- **Ported by:** pitch-shifter-formants, 2026-11-16 (compiled, not ported)

| Upstream path | Our path | What |
|---|---|---|
| `single/RubberBandSingle.cpp` (the whole library: R3 "finer" engine, built-in FFT and resampler), `rubberband/rubberband-c.h` | `packages/audio-fx/wasm/rubberband.wasm` (built by `scripts/rubberband-wasm/build.sh` with `glue.cpp` and `shim.h`) | Rubber Band R3 pitch shifting with formant preservation, as a separate reactor-style wasm32 module driven through its C API by `packages/audio-fx/src/effects/pitch/rubberband.ts` |

Notes: GPL-2.0-or-later is an exception to AGENTS.md §2 that the project's owner accepted for this privately used editor:
Rubber Band is allowed only inside this separate, replaceable module (rebuild from the pinned source, or a modified one,
with the script; the engine also honours `JASPER_RUBBERBAND_WASM`). The application's JavaScript only loads the module;
FFmpeg stays LGPL and is never built with librubberband. Without the module the Pitch Shifter falls back to Signalsmith
Stretch and warns. Build pins, flags and the module's sha256: `packages/audio-fx/wasm/RUBBERBAND-WASM.json`; source offer
and rebuild route: `packages/audio-fx/wasm/NOTICE-rubberband.txt`.

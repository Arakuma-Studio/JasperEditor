// Imported first by every GL test entry: turns on the fx host's scratch-target poisoning (src/fx/host.ts `poison`,
// golden-fuzz): pooled intermediates start as NaN (float) / opaque magenta (8-bit), so a shader that skips pixels
// fails its test. Never imported by app code.
(globalThis as { __JASPER_FX_POISON__?: boolean }).__JASPER_FX_POISON__ = true;

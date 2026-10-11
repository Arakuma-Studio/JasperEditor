// Import before the GPU host: pooled intermediates start as NaN (float) or opaque magenta (8-bit),
// so shaders that skip pixels fail their tests. Never import into app code.
(globalThis as { __JASPER_FX_POISON__?: boolean }).__JASPER_FX_POISON__ = true;

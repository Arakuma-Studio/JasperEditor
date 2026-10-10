// @jasper/testkit — test-only helpers shared by every package (a devDependency; never imported by app code).
//
// - golden: difference metrics, tolerances, golden PNGs (`JASPER_BLESS=1`), fingerprints, pins, scene guards
// - png / image: PNG codec and RGBA8 helpers
// - fuzz: deterministic mutation fuzzing + fast-check properties for parsers (`describeFuzz`)
// - oracle: ffmpeg / ffprobe discovery (`JASPER_REQUIRE_ORACLES=1`), EBU R128, PSNR/SSIM, packet/frame tables
// - browser: headless Chrome on SwiftShader for WebGL2 tests
// See docs/testing.md.
export * from './env.ts';
export * from './golden.ts';
export * from './image.ts';
export * from './oracle.ts';
export * from './png.ts';

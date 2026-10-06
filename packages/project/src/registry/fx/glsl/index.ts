// The shared GLSL library of the fx framework (wave 1). Each chunk is a `GlslChunk` listed in a pass's `include`;
// dependencies are pulled in automatically, each chunk once. Function names start with `fx_`, constants with `FX_`.
// Catalogue (every function is compiled by packages/compositions/test/fx-gl.test.ts in Chrome's WebGL2):
//   fx/hash       fx_pcg, fx_hash1/2/3, fx_hash22/33, fx_random (integer, seeded, exact on every GPU)
//   fx/noise      fx_valueNoise(3), fx_gradientNoise, fx_simplex(3), fx_fbm(3), fx_turbulence, fx_ridged,
//                 fx_cellular, fx_cellId
//   fx/color      fx_luma, fx_saturate, fx_srgbToLinear/fx_linearToSrgb, fx_rgb2hsv/fx_hsv2rgb,
//                 fx_rgb2hsl/fx_hsl2rgb, fx_hueShift, fx_brightnessContrast, fx_tint
//   fx/blend      fx_blendRgb(mode, …), fx_blend(mode, base, top, opacity), fx_over, fx_addLight, FX_BLEND_*
//   fx/sample     fx_sampleEdge(t, uv, mode), fx_sampleTransparent, fx_sampleLayer, fx_mirrorUv, FX_EDGE_*
//   fx/uv         fx_rot, fx_rotateAround, fx_scaleAround, fx_toPolar/fx_fromPolar, fx_deg, fx_dir, FX_PI/FX_TAU
//   fx/blur       fx_gaussian1d, fx_box1d, fx_blur9, fx_zoomBlur, fx_gaussianWeight
//   fx/lut        fx_lut3d, fx_lutMix (3D LUTs of `lut` media params)
//   fx/mb         fx_mbTapCount, fx_mbJitter, fx_mbTapAt, fx_mbJitterFor, fx_mbDyn, fx_mbShutter (adaptive motion blur)
//   fx/mb-poses   fx_mbTaps, fx_mbOn, fx_mbTap, fx_mbPose, fx_mbPlanJitter (planned shutters, needs mbUniforms;
//                 not in GLSL_LIBRARY because it reads the planner's uniforms)
//   fx/composite  fx_finish, fx_mixOriginal, fx_matteView, fx_lumaMatte, fx_colorDistanceMatte, fx_applyMatte,
//                 fx_setAlpha
// Always available without an include (the prelude): fx_canvasPx, fx_layerPx, fx_layerNorm, fx_uvOfCanvasPx,
// fx_uvOfLayerPx, fx_uvOfLayerNorm, fx_inBox, fx_premultiply, fx_unpremultiply, fx_sample.
import { GLSL_BLEND } from './blend.ts';
import { GLSL_BLUR } from './blur.ts';
import { GLSL_COLOR } from './color.ts';
import { GLSL_COMPOSITE } from './composite.ts';
import { GLSL_HASH } from './hash.ts';
import { GLSL_LUT } from './lut.ts';
import { GLSL_MB } from './motion-blur.ts';
import { GLSL_NOISE } from './noise.ts';
import { GLSL_SAMPLE, GLSL_UV } from './sample.ts';

export { FX_BLEND_MODE_LABELS, FX_BLEND_MODES, GLSL_BLEND } from './blend.ts';
export { FX_BLUR_MAX_TAPS, GLSL_BLUR } from './blur.ts';
export { GLSL_COLOR } from './color.ts';
export { GLSL_COMPOSITE } from './composite.ts';
export { GLSL_HASH } from './hash.ts';
export { GLSL_LUT } from './lut.ts';
export {
	FX_MB_MAX_TAPS,
	FX_MB_SPACING,
	FX_MB_TAP_LIMIT,
	FX_MB_WARP_SIZE,
	GLSL_MB,
	GLSL_MB_POSES,
} from './motion-blur.ts';
export { GLSL_NOISE } from './noise.ts';
export { FX_EDGE_MODE_LABELS, FX_EDGE_MODES, GLSL_SAMPLE, GLSL_UV } from './sample.ts';

/** Every library chunk (the GL test compiles them all together). */
export const GLSL_LIBRARY = [
	GLSL_HASH,
	GLSL_NOISE,
	GLSL_COLOR,
	GLSL_BLEND,
	GLSL_SAMPLE,
	GLSL_UV,
	GLSL_BLUR,
	GLSL_COMPOSITE,
	GLSL_LUT,
	GLSL_MB,
] as const;

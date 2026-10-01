/*
 * glue.c: the JasperEditor side of the vid.stab WebAssembly module (scripts/vidstab-wasm/build.sh).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 * Copyright (C) 2026 the JasperEditor authors.
 *
 * This file is linked together with libvidstab (LGPL-2.1-or-later, pinned commit in manifest.json) into
 * vidstab.wasm and is distributed under the same licence. It is our own code: a small, allocation-owning,
 * import-free API around vid.stab for a reactor-style module (no `_start`, no main):
 *
 *   detection   vsx_detect_init / vsx_detect_luma / vsx_detect_frame / vsx_detect_motions / vsx_detect_restart
 *               8-bit luma in, the frame's LocalMotions out (flat doubles). Several instances can detect
 *               disjoint chunks of a clip in parallel (vsx_detect_restart starts a new chunk: the first
 *               frame of a chunk only primes the "previous" frame, exactly like frame 0 of a clip).
 *   camera path vsx_path_init / vsx_path_scratch / vsx_path_add / vsx_path_compute / vsx_path_result
 *               all LocalMotions of the clip in, the per-frame correcting transforms out
 *               (vsLocalmotions2Transforms + vsPreprocessTransforms: smoothing, camera-path algorithm,
 *               optimal zoom, maxshift, maxangle).
 *   warp        vsx_warp_rgb48: applies one transform to interleaved 16-bit RGB in float, bicubic
 *               (the Catmull-Rom kernel of vid.stab's interpolateBiCub), same geometry as vid.stab's
 *               transformPlanar; row bands so several instances can share one frame.
 *   reference   vsx_ref_*: vid.stab's own 8-bit transform (for validating the warp numerically).
 *
 * WASM SIMD: the motion-detection kernels (compareSubImg / contrastSubImg1) have SSE2/AVX2/NEON versions
 * upstream but nothing for wasm32, and clang's <emmintrin.h> is x86-only, so this file carries wasm_simd128
 * ports of the NEON kernels (same arithmetic, same early exit => bit-identical results to the scalar C) and
 * installs them through vid.stab's own dispatch pointers after vsMotionDetectInit.
 */

#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libvidstab.h"
#include "motiondetect_internal.h"
#include "motiondetect_opt.h"
#include "transformtype_operations.h"

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

#define EXPORT(name) __attribute__((export_name(#name)))

/* ---------------------------------------------------------------- logging --- */

static char log_buf[16384];
static int log_len = 0;

static int glue_log(int type, const char* tag, const char* format, ...) {
  if (type > vs_log_level) return 0;
  const int cap = (int)sizeof(log_buf) - 1;
  if (log_len >= cap - 64) return 0;
  const char* kind = type == 0 ? "error" : type == 1 ? "warn" : type == 2 ? "info" : "msg";
  int n = snprintf(log_buf + log_len, (size_t)(cap - log_len), "%s %s: ", kind, tag ? tag : "");
  if (n > 0) log_len += n;
  if (log_len >= cap) log_len = cap;
  va_list ap;
  va_start(ap, format);
  n = vsnprintf(log_buf + log_len, (size_t)(cap - log_len), format, ap);
  va_end(ap);
  if (n > 0) log_len += n;
  if (log_len >= cap) log_len = cap;
  /* one message per line */
  while (log_len > 0 && log_buf[log_len - 1] == '\n') log_len--;
  if (log_len < cap) log_buf[log_len++] = '\n';
  log_buf[log_len] = 0;
  return 0;
}

EXPORT(vsx_log_ptr) const char* vsx_log_ptr(void) { return log_buf; }
EXPORT(vsx_log_len) int vsx_log_len(void) { return log_len; }
EXPORT(vsx_log_clear) void vsx_log_clear(void) { log_len = 0; log_buf[0] = 0; }
/** 0 errors, 1 +warnings (default), 2 +info, 3 +messages. */
EXPORT(vsx_set_log_level) void vsx_set_log_level(int level) { vs_log_level = level; }

static int glue_ready = 0;
static void glue_setup(void) {
  if (glue_ready) return;
  vs_log = glue_log;
  vs_log_level = 1;
  glue_ready = 1;
}

/* ----------------------------------------------------------------- memory --- */

EXPORT(vsx_malloc) void* vsx_malloc(size_t n) { return malloc(n); }
EXPORT(vsx_free) void vsx_free(void* p) { free(p); }
EXPORT(vsx_version) const char* vsx_version(void) { return LIBVIDSTAB_VERSION; }

/* ------------------------------------------------- WASM SIMD motion kernels --- */

static int use_simd = 1;
/** 1: install the wasm_simd128 kernels (default when compiled with -msimd128); 0: vid.stab's scalar C. */
EXPORT(vsx_set_simd) void vsx_set_simd(int on) { use_simd = on; }

#ifdef __wasm_simd128__
static inline unsigned int hadd_u32x4(v128_t v) {
  return wasm_u32x4_extract_lane(v, 0) + wasm_u32x4_extract_lane(v, 1) + wasm_u32x4_extract_lane(v, 2) +
         wasm_u32x4_extract_lane(v, 3);
}

/* Port of compareSubImg_thr_neon: sum of absolute differences, early exit after each row once the running
   sum exceeds the threshold (so the value equals compareSubImg_thr's). The field size is a multiple of 16
   (vsMotionDetectInit rounds it), so there is no tail. u16 lanes gain <= 2*255 per row: drain every 16. */
static unsigned int compare_wasm(unsigned char* const I1, unsigned char* const I2, const Field* field,
                                 int linesize1, int linesize2, int height, int bytesPerPixel, int d_x,
                                 int d_y, unsigned int threshold) {
  if (bytesPerPixel != 1)
    return compareSubImg_thr(I1, I2, field, linesize1, linesize2, height, bytesPerPixel, d_x, d_y,
                             threshold);
  const int s2 = field->size / 2;
  const unsigned char* p1 = I1 + (field->x - s2) + (field->y - s2) * linesize1;
  const unsigned char* p2 = I2 + (field->x - s2 + d_x) + (field->y - s2 + d_y) * linesize2;
  v128_t acc16 = wasm_i16x8_splat(0);
  v128_t acc32 = wasm_i32x4_splat(0);
  unsigned int sum = 0;
  for (int j = 0; j < field->size; j++) {
    for (int k = 0; k < field->size; k += 16) {
      v128_t a = wasm_v128_load(p1 + k);
      v128_t b = wasm_v128_load(p2 + k);
      v128_t d = wasm_v128_or(wasm_u8x16_sub_sat(a, b), wasm_u8x16_sub_sat(b, a));
      acc16 = wasm_i16x8_add(acc16, wasm_u16x8_extadd_pairwise_u8x16(d));
    }
    if ((j & 15) == 15) {
      acc32 = wasm_i32x4_add(acc32, wasm_u32x4_extadd_pairwise_u16x8(acc16));
      acc16 = wasm_i16x8_splat(0);
    }
    sum = hadd_u32x4(wasm_i32x4_add(acc32, wasm_u32x4_extadd_pairwise_u16x8(acc16)));
    if (sum > threshold) return sum;
    p1 += linesize1;
    p2 += linesize2;
  }
  return sum;
}

static double contrast_wasm(unsigned char* const I, const Field* field, int linesize, int height) {
  const int s2 = field->size / 2;
  const unsigned char* p = I + (field->x - s2) + (field->y - s2) * linesize;
  v128_t vmin = wasm_i8x16_splat((int8_t)0xFF);
  v128_t vmax = wasm_i8x16_splat(0);
  for (int j = 0; j < field->size; j++) {
    for (int k = 0; k < field->size; k += 16) {
      v128_t v = wasm_v128_load(p + k);
      vmin = wasm_u8x16_min(vmin, v);
      vmax = wasm_u8x16_max(vmax, v);
    }
    p += linesize;
  }
  unsigned char mini = 255, maxi = 0;
  uint8_t lo[16], hi[16];
  wasm_v128_store(lo, vmin);
  wasm_v128_store(hi, vmax);
  for (int i = 0; i < 16; i++) {
    if (lo[i] < mini) mini = lo[i];
    if (hi[i] > maxi) maxi = hi[i];
  }
  return (maxi - mini) / (maxi + mini + 0.1);
}
#endif

static const char* simd_name = "scalar";
static void install_kernels(void) {
  vs_simd_init();
#ifdef __wasm_simd128__
  if (use_simd) {
    compareSubImg = compare_wasm;
    contrastSubImg1 = contrast_wasm;
    simd_name = "wasm-simd128";
    return;
  }
  compareSubImg = compareSubImg_thr;
  /* contrastSubImg1 keeps vid.stab's portable default (vs_simd_init found no x86/ARM kernels). */
#endif
  simd_name = vs_simd_active_name();
}
EXPORT(vsx_simd) const char* vsx_simd(void) { return simd_name; }

/* -------------------------------------------------------------- detection --- */

static VSMotionDetect md;
static VSFrameInfo md_fi;
static int md_ready = 0;
static uint8_t* md_luma = NULL;
static double* md_out = NULL;
static int md_out_cap = 0;

/** Number of doubles per exported LocalMotion: v.x, v.y, f.x, f.y, f.size, contrast, match. */
#define VSX_LM_STRIDE 7

EXPORT(vsx_detect_free) void vsx_detect_free(void) {
  if (md_ready) vsMotionDetectionCleanup(&md);
  md_ready = 0;
  free(md_luma);
  md_luma = NULL;
  free(md_out);
  md_out = NULL;
  md_out_cap = 0;
}

/** Prepares detection on width x height 8-bit luma frames. Returns 0 or -1. */
EXPORT(vsx_detect_init)
int vsx_detect_init(int width, int height, int shakiness, int accuracy, int stepSize, double minContrast) {
  glue_setup();
  vsx_detect_free();
  if (!vsFrameInfoInit(&md_fi, width, height, PF_GRAY8)) return -1;
  VSMotionDetectConfig conf = vsMotionDetectGetDefaultConfig("vidstab-wasm");
  conf.shakiness = shakiness;
  conf.accuracy = accuracy;
  conf.stepSize = stepSize;
  conf.contrastThreshold = minContrast;
  conf.virtualTripod = 0;
  conf.show = 0;
  conf.numThreads = 1;
  memset(&md, 0, sizeof(md));
  if (vsMotionDetectInit(&md, &conf, &md_fi) != VS_OK) return -1;
  md_ready = 1;
  install_kernels();
  md_luma = (uint8_t*)calloc((size_t)width * (size_t)height + 64, 1);
  return md_luma ? 0 : -1;
}

/** The width*height luma buffer the next vsx_detect_frame reads. */
EXPORT(vsx_detect_luma) uint8_t* vsx_detect_luma(void) { return md_luma; }

/** Starts a new chunk: the next frame only becomes the reference (its motions are empty). */
EXPORT(vsx_detect_restart) void vsx_detect_restart(void) {
  if (md_ready) md.hasSeenOneFrame = 0;
}

/** Detects the motion between the previous frame and the luma buffer. Returns the number of LocalMotions
    (read them from vsx_detect_motions, VSX_LM_STRIDE doubles each) or -1. */
EXPORT(vsx_detect_frame) int vsx_detect_frame(void) {
  if (!md_ready) return -1;
  VSFrame frame;
  vsFrameFillFromBuffer(&frame, md_luma, &md_fi);
  LocalMotions lms;
  if (vsMotionDetection(&md, &lms, &frame) != VS_OK) return -1;
  int n = vs_vector_size(&lms);
  if (n > md_out_cap) {
    free(md_out);
    md_out = (double*)malloc(sizeof(double) * VSX_LM_STRIDE * (size_t)n);
    md_out_cap = md_out ? n : 0;
    if (!md_out) {
      vs_vector_del(&lms);
      return -1;
    }
  }
  for (int i = 0; i < n; i++) {
    const LocalMotion* m = LMGet(&lms, i);
    double* o = md_out + (size_t)i * VSX_LM_STRIDE;
    o[0] = m->v.x;
    o[1] = m->v.y;
    o[2] = m->f.x;
    o[3] = m->f.y;
    o[4] = m->f.size;
    o[5] = m->contrast;
    o[6] = m->match;
  }
  vs_vector_del(&lms);
  return n;
}

EXPORT(vsx_detect_motions) const double* vsx_detect_motions(void) { return md_out; }

/* ------------------------------------------------------------ camera path --- */

static VSManyLocalMotions path_lms;
static int path_ready = 0;
static VSFrameInfo path_fi;
static double* path_scratch = NULL;
static int path_scratch_cap = 0;
static double* path_out = NULL;
static double path_zoom = 0;

EXPORT(vsx_path_free) void vsx_path_free(void) {
  if (path_ready) {
    int n = vs_vector_size(&path_lms);
    for (int i = 0; i < n; i++) {
      LocalMotions* lms = VSMLMGet(&path_lms, i);
      if (lms) vs_vector_del(lms);
    }
    vs_vector_del(&path_lms);
  }
  path_ready = 0;
  free(path_scratch);
  path_scratch = NULL;
  path_scratch_cap = 0;
  free(path_out);
  path_out = NULL;
}

/** Starts collecting LocalMotions of a clip whose detection frames are width x height. */
EXPORT(vsx_path_init) int vsx_path_init(int width, int height) {
  glue_setup();
  vsx_path_free();
  if (!vsFrameInfoInit(&path_fi, width, height, PF_GRAY8)) return -1;
  if (vs_vector_init(&path_lms, 1024) != VS_OK) return -1;
  path_ready = 1;
  return 0;
}

/** A buffer for `count` LocalMotions (VSX_LM_STRIDE doubles each) to be filled before vsx_path_add. */
EXPORT(vsx_path_scratch) double* vsx_path_scratch(int count) {
  if (count < 1) count = 1;
  if (count > path_scratch_cap) {
    free(path_scratch);
    path_scratch = (double*)malloc(sizeof(double) * VSX_LM_STRIDE * (size_t)count);
    path_scratch_cap = path_scratch ? count : 0;
  }
  return path_scratch;
}

/** Appends the next frame's `count` LocalMotions from the scratch buffer. */
EXPORT(vsx_path_add) int vsx_path_add(int count) {
  if (!path_ready || count > path_scratch_cap) return -1;
  LocalMotions* lms = (LocalMotions*)malloc(sizeof(LocalMotions));
  if (!lms || vs_vector_init(lms, count > 0 ? count : 1) != VS_OK) return -1;
  for (int i = 0; i < count; i++) {
    const double* s = path_scratch + (size_t)i * VSX_LM_STRIDE;
    LocalMotion m;
    m.v.x = (int16_t)s[0];
    m.v.y = (int16_t)s[1];
    m.f.x = (int16_t)s[2];
    m.f.y = (int16_t)s[3];
    m.f.size = (int16_t)s[4];
    m.contrast = s[5];
    m.match = s[6];
    vs_vector_append_dup(lms, &m, sizeof(LocalMotion));
  }
  return vs_vector_append(&path_lms, lms) == VS_OK ? 0 : -1;
}

/**
 * Turns the collected LocalMotions into per-frame correcting transforms. camPathAlgo: 0 optimal L1,
 * 1 gaussian, 2 averaging; optZoom 0/1/2 (none / optimal static / adaptive); zoom in percent is added;
 * maxShift in detection pixels (-1 = unlimited), maxAngle in rad (-1 = unlimited). Returns the frame
 * count (read [x, y, alpha, zoom] per frame from vsx_path_result) or -1.
 */
EXPORT(vsx_path_compute)
int vsx_path_compute(int smoothing, int camPathAlgo, int optZoom, double zoom, double zoomSpeed, int maxShift,
                     double maxAngle) {
  if (!path_ready) return -1;
  VSTransformConfig conf = vsTransformGetDefaultConfig("vidstab-wasm");
  conf.relative = 1;
  conf.invert = 0;
  conf.smoothing = smoothing;
  conf.camPathAlgo = (VSCamPathAlgo)camPathAlgo;
  conf.optZoom = optZoom;
  conf.zoom = zoom;
  conf.zoomSpeed = zoomSpeed;
  conf.maxShift = maxShift;
  conf.maxAngle = maxAngle;
  conf.crop = VSCropBorder;
  conf.interpolType = VS_BiCubic;
  conf.simpleMotionCalculation = 0;
  conf.storeTransforms = 0;
  conf.smoothZoom = 0;
  /* Plain similarity transforms only: the warp is applied outside vid.stab (16-bit float), so neither the
     lens (wobble) model nor the rotational fov model may leak into the numbers. */
  conf.estimateLensDistortion = 0;
  conf.lensCorrection = VSLensCorrectOff;
  conf.lensK = 0.0;
  conf.fov = 0.0;
  VSTransformData td;
  memset(&td, 0, sizeof(td));
  if (vsTransformDataInit(&td, &conf, &path_fi, &path_fi) != VS_OK) return -1;
  VSTransformations trans;
  vsTransformationsInit(&trans);
  int rc = vsLocalmotions2Transforms(&td, &path_lms, &trans);
  if (rc == VS_OK) rc = vsPreprocessTransforms(&td, &trans);
  int n = rc == VS_OK ? trans.len : -1;
  if (n >= 0) {
    free(path_out);
    path_out = (double*)malloc(sizeof(double) * 4 * (size_t)(n > 0 ? n : 1));
    if (!path_out) n = -1;
    for (int i = 0; i < n; i++) {
      path_out[i * 4 + 0] = trans.ts[i].x;
      path_out[i * 4 + 1] = trans.ts[i].y;
      path_out[i * 4 + 2] = trans.ts[i].alpha;
      path_out[i * 4 + 3] = trans.ts[i].zoom;
    }
    path_zoom = td.conf.zoom;
  }
  vsTransformationsCleanup(&trans);
  vsTransformDataCleanup(&td);
  return n;
}

EXPORT(vsx_path_result) const double* vsx_path_result(void) { return path_out; }
/** The global zoom (percent) vsPreprocessTransforms settled on (optZoom 1), already included per frame. */
EXPORT(vsx_path_zoom) double vsx_path_zoom(void) { return path_zoom; }

/* -------------------------------------------------- 16-bit RGB bicubic warp --- */

/* vid.stab's interpolateBiCub kernel (Catmull-Rom, a = -0.5) as weights. */
static inline void cubic_weights(float t, float w[4]) {
  const float t2 = t * t, t3 = t2 * t;
  w[0] = 0.5f * (-t + 2.0f * t2 - t3);
  w[1] = 0.5f * (2.0f - 5.0f * t2 + 3.0f * t3);
  w[2] = 0.5f * (t + 4.0f * t2 - 3.0f * t3);
  w[3] = 0.5f * (-t2 + t3);
}

static inline int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Applies the vid.stab transform (x, y, alpha, zoom) to an interleaved rgb48 frame, writing destination
 * rows [y0, y1) to `dst` (row y0 first). `src` holds source rows [srcRow0, srcRow0 + srcRows) (callers pass
 * only the band the destination rows can reach; taps are clamped into it, and it must cover every in-frame
 * row the band needs) and must be readable 8 bytes past its end.
 *
 * Geometry (vid.stab transformPlanar): destination pixel p_d maps to source
 *   p_s = z * R(alpha) (p_d - c) + c - (x, y),   z = 1 - zoom/100,  c = (w/2, h/2) integer-divided,
 *   R(alpha) = [cos a, -sin a; sin a, cos a].
 * border 0 = black (fades the edge pixel to black over 10 px outside the frame, like vid.stab's
 * interpolateBiLinBorder with crop=black), 1 = replicate the edge pixels.
 */
#ifdef __wasm_simd128__
/* Source band as RGBx float (one aligned v128 per pixel): converting once per source pixel instead of once
   per tap (16 per destination pixel) roughly halves the warp time. */
static float* warp_f = NULL;
static size_t warp_f_cap = 0;
#endif

EXPORT(vsx_warp_rgb48)
void vsx_warp_rgb48(const uint16_t* src, int srcRow0, int srcRows, uint16_t* dst, int width, int height,
                    double tx, double ty, double alpha, double zoom, int border, int y0, int y1) {
  const double z = 1.0 - zoom / 100.0;
  const double zc = z * cos(alpha), zs = z * sin(alpha);
  const int cx = width / 2, cy = height / 2;
  const int rowLo = srcRow0 > 0 ? srcRow0 : 0;
  const int rowHi = (srcRow0 + srcRows - 1) < (height - 1) ? (srcRow0 + srcRows - 1) : (height - 1);
  const size_t stride = (size_t)width * 3;
#ifdef __wasm_simd128__
  const size_t fstride = (size_t)width * 4;
  {
    const size_t need = fstride * (size_t)srcRows;
    if (need > warp_f_cap) {
      free(warp_f);
      warp_f = (float*)aligned_alloc(16, need * sizeof(float));
      warp_f_cap = warp_f ? need : 0;
      if (!warp_f) return;
    }
    const size_t npx = (size_t)width * (size_t)srcRows;
    for (size_t i = 0; i < npx; i++)
      wasm_v128_store(warp_f + i * 4,
                      wasm_f32x4_convert_i32x4(wasm_u32x4_extend_low_u16x8(wasm_v128_load64_zero(src + i * 3))));
  }
#endif
  for (int y = y0; y < y1; y++) {
    const double dy = (double)(y - cy);
    const double xs0 = -zs * dy + cx - tx; /* + zc * dx */
    const double ys0 = zc * dy + cy - ty;  /* + zs * dx */
    uint16_t* out = dst + (size_t)(y - y0) * stride;
    for (int x = 0; x < width; x++) {
      const double dx = (double)(x - cx);
      const double xs = xs0 + zc * dx;
      const double ys = ys0 + zs * dx;
      const double fxd = floor(xs), fyd = floor(ys);
      const int ix = (int)fxd, iy = (int)fyd;
      float fade = 0.0f; /* 0 = the interpolated value, 1 = black */
      if (border == 0 && (ix < 0 || iy < 0 || ix + 1 >= width || iy + 1 >= height)) {
        int c = -10 - ix;
        int t = -10 - iy;
        if (t > c) c = t;
        t = ix + 1 - 10 - width;
        if (t > c) c = t;
        t = iy + 1 - 10 - height;
        if (t > c) c = t;
        c = clampi(c, 0, 10);
        if (c == 10) {
          out[x * 3 + 0] = out[x * 3 + 1] = out[x * 3 + 2] = 0;
          continue;
        }
        fade = (float)c / 10.0f;
      }
      float wx[4], wy[4];
      cubic_weights((float)(xs - fxd), wx);
      cubic_weights((float)(ys - fyd), wy);
      int rows[4]; /* band-relative row index */
      int cols[4]; /* pixel index */
      if (ix >= 1 && ix + 2 < width && iy - 1 >= rowLo && iy + 2 <= rowHi) {
        rows[0] = iy - 1 - srcRow0;
        rows[1] = rows[0] + 1;
        rows[2] = rows[0] + 2;
        rows[3] = rows[0] + 3;
        cols[0] = ix - 1;
        cols[1] = ix;
        cols[2] = ix + 1;
        cols[3] = ix + 2;
      } else {
        for (int k = 0; k < 4; k++) {
          rows[k] = clampi(clampi(iy - 1 + k, 0, height - 1), rowLo, rowHi) - srcRow0;
          cols[k] = clampi(ix - 1 + k, 0, width - 1);
        }
      }
#ifdef __wasm_simd128__
      v128_t acc = wasm_f32x4_splat(0.0f);
      for (int r = 0; r < 4; r++) {
        const float* row = warp_f + (size_t)rows[r] * fstride;
        v128_t h = wasm_f32x4_mul(wasm_v128_load(row + cols[0] * 4), wasm_f32x4_splat(wx[0]));
        h = wasm_f32x4_add(h, wasm_f32x4_mul(wasm_v128_load(row + cols[1] * 4), wasm_f32x4_splat(wx[1])));
        h = wasm_f32x4_add(h, wasm_f32x4_mul(wasm_v128_load(row + cols[2] * 4), wasm_f32x4_splat(wx[2])));
        h = wasm_f32x4_add(h, wasm_f32x4_mul(wasm_v128_load(row + cols[3] * 4), wasm_f32x4_splat(wx[3])));
        acc = wasm_f32x4_add(acc, wasm_f32x4_mul(h, wasm_f32x4_splat(wy[r])));
      }
      if (fade > 0.0f) acc = wasm_f32x4_mul(acc, wasm_f32x4_splat(1.0f - fade));
      acc = wasm_f32x4_pmin(wasm_f32x4_pmax(wasm_f32x4_add(acc, wasm_f32x4_splat(0.5f)), wasm_f32x4_splat(0.0f)),
                            wasm_f32x4_splat(65535.0f));
      const v128_t iv = wasm_i32x4_trunc_sat_f32x4(acc);
      out[x * 3 + 0] = (uint16_t)wasm_i32x4_extract_lane(iv, 0);
      out[x * 3 + 1] = (uint16_t)wasm_i32x4_extract_lane(iv, 1);
      out[x * 3 + 2] = (uint16_t)wasm_i32x4_extract_lane(iv, 2);
#else
      for (int ch = 0; ch < 3; ch++) {
        float acc = 0.0f;
        for (int r = 0; r < 4; r++) {
          const uint16_t* row = src + (size_t)rows[r] * stride;
          float h = 0.0f;
          for (int k = 0; k < 4; k++) h += wx[k] * (float)row[cols[k] * 3 + ch];
          acc += wy[r] * h;
        }
        acc = acc * (1.0f - fade) + 0.5f;
        out[x * 3 + ch] = (uint16_t)(acc <= 0.0f ? 0 : acc >= 65535.0f ? 65535 : (int)acc);
      }
#endif
    }
  }
}

/* --------------------------------------- reference: vid.stab's 8-bit transform --- */

static VSTransformData ref_td;
static VSFrameInfo ref_fi;
static int ref_ready = 0;
static uint8_t* ref_src = NULL;
static uint8_t* ref_dst = NULL;

EXPORT(vsx_ref_free) void vsx_ref_free(void) {
  if (ref_ready) vsTransformDataCleanup(&ref_td);
  ref_ready = 0;
  free(ref_src);
  free(ref_dst);
  ref_src = ref_dst = NULL;
}

/** vid.stab's own transform on 8-bit gray frames. crop: 0 keep, 1 black; interpol: 0..3 (3 = bicubic). */
EXPORT(vsx_ref_init) int vsx_ref_init(int width, int height, int crop, int interpol) {
  glue_setup();
  vsx_ref_free();
  if (!vsFrameInfoInit(&ref_fi, width, height, PF_GRAY8)) return -1;
  VSTransformConfig conf = vsTransformGetDefaultConfig("vidstab-wasm-ref");
  conf.crop = crop ? VSCropBorder : VSKeepBorder;
  conf.interpolType = (VSInterpolType)interpol;
  conf.optZoom = 0;
  conf.smoothing = 0;
  conf.estimateLensDistortion = 0;
  conf.lensCorrection = VSLensCorrectOff;
  conf.fov = 0.0;
  memset(&ref_td, 0, sizeof(ref_td));
  if (vsTransformDataInit(&ref_td, &conf, &ref_fi, &ref_fi) != VS_OK) return -1;
  ref_ready = 1;
  ref_src = (uint8_t*)calloc((size_t)width * height, 1);
  ref_dst = (uint8_t*)calloc((size_t)width * height, 1);
  return ref_src && ref_dst ? 0 : -1;
}
EXPORT(vsx_ref_src) uint8_t* vsx_ref_src(void) { return ref_src; }
EXPORT(vsx_ref_dst) uint8_t* vsx_ref_dst(void) { return ref_dst; }

EXPORT(vsx_ref_apply) int vsx_ref_apply(double x, double y, double alpha, double zoom) {
  if (!ref_ready) return -1;
  VSFrame s, d;
  vsFrameFillFromBuffer(&s, ref_src, &ref_fi);
  vsFrameFillFromBuffer(&d, ref_dst, &ref_fi);
  if (vsTransformPrepare(&ref_td, &s, &d) != VS_OK) return -1;
  VSTransform t = new_transform(x, y, alpha, zoom, 0, 0, 0);
  if (vsDoTransform(&ref_td, t) != VS_OK) return -1;
  return vsTransformFinish(&ref_td) == VS_OK ? 0 : -1;
}

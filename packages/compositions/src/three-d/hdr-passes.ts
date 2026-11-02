// The floating-point half of Advanced 3D (spec 19 TL-075 to TL-077): environment prefiltering, the tone-map-aware MSAA
// resolve, supersampling, glints, and the tone mapped composite over the backdrop. Raw WebGL2 passes on RGBA16F targets,
// in the same code for the Player and for Remotion. Ported from Pachislop `src/engine/three/{tonemap,hdrResolve,resample,
// glint}.ts` (licenses/ported/pachislop-three-d.md), with three.js's PMREM replaced by our own GGX prefilter.
import {
	GLSL_COLOR,
	GLSL_HASH,
	GLSL_TL_ENV,
	GLSL_UV,
	resolveIncludes,
	type ToneMapping,
} from '@jasper/project';

/** What every pass needs from the renderer. */
export type HdrKit = {
	gl: WebGL2RenderingContext;
	/** A named RGBA16F texture, reallocated when its size changes. */
	target(name: string, w: number, h: number, mips?: number): WebGLTexture;
	program(key: string, fragment: string): WebGLProgram;
	uniform(prog: WebGLProgram, name: string): WebGLUniformLocation | null;
	/** Framebuffer of the single-target passes. */
	fbo: WebGLFramebuffer;
	/** Full-screen triangle. */
	quad: WebGLVertexArrayObject;
};

const glsl = (chunks: Parameters<typeof resolveIncludes>[0]) =>
	resolveIncludes(chunks)
		.map((c) => c.source)
		.join('\n');

/** A full-screen pass into `dst` (a texture, mip `level`), or the bound framebuffer with `dst` null. */
export function runPass(
	kit: HdrKit,
	prog: WebGLProgram,
	dst: WebGLTexture | null,
	w: number,
	h: number,
	setup: (u: (name: string) => WebGLUniformLocation | null) => void,
	level = 0,
): void {
	const { gl } = kit;
	if (dst) {
		gl.bindFramebuffer(gl.FRAMEBUFFER, kit.fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, level);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
	}
	gl.viewport(0, 0, w, h);
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(prog);
	setup((name) => kit.uniform(prog, name));
	gl.bindVertexArray(kit.quad);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.bindVertexArray(null);
}

function bindTexture(gl: WebGL2RenderingContext, unit: number, t: WebGLTexture, loc: WebGLUniformLocation | null): void {
	gl.activeTexture(gl.TEXTURE0 + unit);
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.uniform1i(loc, unit);
}

/**
 * The knee of the tone curves (Neutral's shoulder start) and the headroom of the resolve's shoulder: every sample is
 * written through it, so a hot edge averages what the tone map would show, and `EXPAND_FS` inverts it after the resolve
 * (Karis, "Tone mapping", 2013). Pachislop measured h = 0.75 against 4× supersampled renders.
 */
export const HDR_SHOULDER_GLSL = /* glsl */ `
const float HDR_KNEE = 0.76;
const float HDR_H = 0.75;
vec3 hdrCompress(vec3 premult, float a, float exposure) {
  float x = max(max(premult.r, premult.g), premult.b) / max(a, 1e-6) * exposure;
  if (x > HDR_KNEE) premult *= (HDR_KNEE + HDR_H * (x - HDR_KNEE) / (HDR_H + x - HDR_KNEE)) / x;
  return premult;
}
`;

const EXPAND_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform float u_exposure;
out vec4 o;
${HDR_SHOULDER_GLSL}
void main() {
  vec4 c = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0);
  float a = clamp(c.a, 0.0, 1.0);
  if (a <= 0.0 || u_exposure <= 0.0) { o = c; return; }
  float y = max(max(c.r, c.g), c.b) / a * u_exposure;
  if (y > HDR_KNEE) {
    float t = min((y - HDR_KNEE) / HDR_H, 1.0 - 1.0 / 4096.0);
    float x = HDR_KNEE + HDR_H * t / (1.0 - t);
    c.rgb *= x / y;
  }
  o = c;
}
`;

/** The compressed resolve back to premultiplied linear light. */
export function expandResolved(kit: HdrKit, src: WebGLTexture, dst: WebGLTexture, w: number, h: number, exposure: number): void {
	const { gl } = kit;
	runPass(kit, kit.program('expand', EXPAND_FS), dst, w, h, (u) => {
		bindTexture(gl, 0, src, u('u_src'));
		gl.uniform1f(u('u_exposure'), exposure);
	});
}

const DOWNSAMPLE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform int u_k;
uniform ivec2 u_axis;
out vec4 o;
float mitchell(float x) {
  x = abs(x);
  const float B = 1.0 / 3.0;
  const float C = 1.0 / 3.0;
  if (x < 1.0) return ((12.0 - 9.0 * B - 6.0 * C) * x * x * x + (-18.0 + 12.0 * B + 6.0 * C) * x * x + (6.0 - 2.0 * B)) / 6.0;
  if (x < 2.0) return ((-B - 6.0 * C) * x * x * x + (6.0 * B + 30.0 * C) * x * x + (-12.0 * B - 48.0 * C) * x + (8.0 * B + 24.0 * C)) / 6.0;
  return 0.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_src, 0);
  bool horizontal = u_axis.x == 1;
  float k = float(u_k);
  int last = (horizontal ? size.x : size.y) - 1;
  float c = (float(horizontal ? p.x : p.y) + 0.5) * k;
  ivec2 base = horizontal ? ivec2(0, p.y) : ivec2(p.x, 0);
  int j0 = int(floor(c - 2.0 * k));
  int j1 = int(ceil(c + 2.0 * k));
  vec4 s = vec4(0.0);
  float ws = 0.0;
  for (int j = j0; j <= j1; j++) {
    float w = mitchell((float(j) + 0.5 - c) / k);
    if (w == 0.0) continue;
    s += texelFetch(u_src, base + u_axis * clamp(j, 0, last), 0) * w;
    ws += w;
  }
  o = s / ws;
  o = vec4(max(o.rgb, vec3(0.0)), clamp(o.a, 0.0, 1.0));
}
`;

/** Reduces a k× render to the output grid with a separable Mitchell–Netravali filter (B = C = 1/3). */
export function downsample(
	kit: HdrKit,
	src: WebGLTexture,
	srcH: number,
	dst: WebGLTexture,
	w: number,
	h: number,
	k: number,
	name: string,
): void {
	const { gl } = kit;
	const prog = kit.program('downsample', DOWNSAMPLE_FS);
	const mid = kit.target(`${name}:mid`, w, srcH);
	runPass(kit, prog, mid, w, srcH, (u) => {
		bindTexture(gl, 0, src, u('u_src'));
		gl.uniform1i(u('u_k'), k);
		gl.uniform2i(u('u_axis'), 1, 0);
	});
	runPass(kit, prog, dst, w, h, (u) => {
		bindTexture(gl, 0, mid, u('u_src'));
		gl.uniform1i(u('u_k'), k);
		gl.uniform2i(u('u_axis'), 0, 1);
	});
}

// ---------- tone mapping and the composite ----------

const TONEMAP_GLSL = /* glsl */ `
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602));
  color /= 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182),
  vec3(-0.5876, 1.1329, -0.1006),
  vec3(-0.0728, -0.0083, 1.1187));
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956));
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 color) {
  const mat3 AgXInsetMatrix = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 AgXOutsetMatrix = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float AgxMinEv = -12.47393;
  const float AgxMaxEv = 4.026069;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AgXInsetMatrix * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
  color = clamp(color, 0.0, 1.0);
  color = agxContrast(color);
  color = AgXOutsetMatrix * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
vec3 neutral(vec3 color) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < StartCompression) return color;
  float d = 1.0 - StartCompression;
  float newPeak = 1.0 - d * d / (peak + d - StartCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
// Hue-preserving: the shoulder compresses the brightest channel and every channel scales by the same factor, so the
// RGB ratios survive where ACES, AgX and Neutral pull saturated gold and red towards grey. Only light several times
// white blends to white, so highlights still read hot.
vec3 hueKeep(vec3 color) {
  const float Start = 0.8 - 0.04;
  const float HotFrom = 3.0;
  const float HotTo = 16.0;
  float x = min(color.r, min(color.g, color.b));
  color -= x < 0.08 ? x - 6.25 * x * x : 0.04;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < Start) return color;
  float d = 1.0 - Start;
  float newPeak = 1.0 - d * d / (peak + d - Start);
  color *= newPeak / peak;
  return mix(color, vec3(newPeak), smoothstep(HotFrom, HotTo, peak));
}
vec3 toneMap(vec3 col, int mode) {
  if (mode == 1) return acesFilmic(col);
  if (mode == 2) return agx(col);
  if (mode == 3) return neutral(col);
  if (mode == 4) return hueKeep(col);
  return clamp(col, 0.0, 1.0);
}
`;

export const TONE_MODE: Record<ToneMapping, number> = { none: 0, aces: 1, agx: 2, neutral: 3, hue: 4 };

const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_scene;
uniform sampler2D u_trans;
uniform sampler2D u_glint;
uniform sampler2D u_back;
uniform int u_hasTrans;
uniform int u_hasGlint;
uniform int u_hasBack;
uniform int u_mode;
uniform float u_exposure;
uniform int u_linearOut;
out vec4 o;
${glsl([GLSL_COLOR])}
${TONEMAP_GLSL}
void main() {
  vec2 st = v_ndc * 0.5 + 0.5;
  vec4 c = texture(u_scene, st);
  if (u_hasGlint == 1) {
    vec3 g = texture(u_glint, st).rgb;
    c.rgb += g;
    c.a += (1.0 - clamp(c.a, 0.0, 1.0)) * clamp(max(g.r, max(g.g, g.b)), 0.0, 1.0);
  }
  vec4 t = u_hasTrans == 1 ? texture(u_trans, st) : vec4(0.0);
  vec4 b = u_hasBack == 1 ? texture(u_back, vec2(st.x, 1.0 - st.y)) : vec4(0.0);
  float a = clamp(c.a, 0.0, 1.0);
  float cover = clamp(t.a, 0.0, 1.0 - a);
  // Where nothing is drawn the backdrop passes through untouched, to the last bit.
  if (a <= 1e-5 && cover <= 1e-5 && u_linearOut == 0) { o = b; return; }
  vec3 lit = vec3(0.0);
  if (a > 1e-5) lit = toneMap(max(c.rgb / a, vec3(0.0)) * u_exposure, u_mode) * a;
  float ba = clamp(b.a, 0.0, 1.0);
  vec3 bl = ba > 1e-5 ? fx_srgbToLinear(clamp(b.rgb / ba, 0.0, 1.0)) * ba : vec3(0.0);
  vec3 rgb = lit + t.rgb + bl * (1.0 - a - cover);
  // A transmitted backdrop keeps its own coverage: glass over nothing stays see-through.
  float oa = a + (1.0 - a) * ba;
  if (u_linearOut == 1) { o = vec4(rgb, oa); return; }
  vec3 s = oa > 1e-5 ? fx_linearToSrgb(clamp(rgb / oa, 0.0, 1.0)) * oa : vec3(0.0);
  o = vec4(s, oa);
}
`;

export type CompositeInput = {
	scene: WebGLTexture;
	trans: WebGLTexture | null;
	glint: WebGLTexture | null;
	backdrop: WebGLTexture | null;
	mode: number;
	exposure: number;
};

/**
 * Tone maps the scene and composites it over the backdrop: into the bound canvas in the signal (sRGB, premultiplied),
 * or into `dst` in linear light (what transmission refracts). The backdrop never goes through the tone curve.
 */
export function composite(kit: HdrKit, c: CompositeInput, w: number, h: number, dst: WebGLTexture | null): void {
	const { gl } = kit;
	runPass(kit, kit.program('composite', COMPOSITE_FS), dst, w, h, (u) => {
		bindTexture(gl, 0, c.scene, u('u_scene'));
		bindTexture(gl, 1, c.trans ?? c.scene, u('u_trans'));
		bindTexture(gl, 2, c.glint ?? c.scene, u('u_glint'));
		bindTexture(gl, 3, c.backdrop ?? c.scene, u('u_back'));
		gl.uniform1i(u('u_hasTrans'), c.trans ? 1 : 0);
		gl.uniform1i(u('u_hasGlint'), c.glint ? 1 : 0);
		gl.uniform1i(u('u_hasBack'), c.backdrop ? 1 : 0);
		gl.uniform1i(u('u_mode'), c.mode);
		gl.uniform1f(u('u_exposure'), c.exposure);
		gl.uniform1i(u('u_linearOut'), dst ? 1 : 0);
	});
	gl.activeTexture(gl.TEXTURE0);
}

// ---------- glints ----------

// The glint runs on the HDR render before tone mapping, so only real highlights glint, not every bright-coloured face.
// Stability, the point of TL-077: a star must follow its highlight as the title turns. Every step that sees a highlight
// is continuous in its position:
// - a soft knee, e² / (e + K), instead of a hard threshold;
// - bright pass and detector on a grid locked to sequence pixels, so an export at any size computes what a 1× one does;
// - a tent prefilter at every mip step: a 2×2 box drops a sub-pixel highlight in and out of a cell as it crosses cell
//   borders, which is the flicker of a naive glint; the tent's response varies only smoothly with the position;
// - a point detector, the bright pass minus the larger of its two 1D blurs: corners and hot spots throw rays, long
//   bevel lines (bright along one axis) do not, so a line of light does not throw a curtain as it sweeps.

export type GlintParams = {
	threshold: number;
	intensity: number;
	/** Bloom radius, output px. */
	radiusPx: number;
	rays: number;
	/** Ray length, output px. */
	lengthPx: number;
	/** Feature size that still counts as a point, output px. */
	detailPx: number;
	/** Output px per sequence px. */
	pxScale: number;
	/** Radians, counter-clockwise. */
	angle: number;
	/** Linear. */
	tint: [number, number, number];
	exposure: number;
};

const LUMA_CLAMP = 64;
const KNEE = 4;
const STREAK_PEAK = 1.2;
const STREAK_TAIL = 0.02;
const MIP_SIGMA = 5;
const DETAIL_SIGMA = 3;
const MAX_LEVEL = 6;

const BRIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform float u_threshold;
uniform float u_exposure;
uniform int u_factor;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * u_factor;
  ivec2 size = textureSize(u_src, 0);
  vec4 c = vec4(0.0);
  for (int y = 0; y < u_factor; y++)
    for (int x = 0; x < u_factor; x++) {
      ivec2 q = p + ivec2(x, y);
      if (all(lessThan(q, size))) c += texelFetch(u_src, q, 0);
    }
  c /= float(u_factor * u_factor);
  o = vec4(0.0, 0.0, 0.0, 1.0);
  if (c.a <= 1e-4) return;
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) / c.a * u_exposure;
  float e = min(l, ${LUMA_CLAMP.toFixed(1)}) - u_threshold;
  if (e <= 0.0) return;
  o.rgb = c.rgb * u_exposure * (e * e / (e + ${KNEE.toFixed(1)})) / max(l, 1e-4);
}
`;

// A 4 × 4 tent over the source: the taps sit between texels, so each samples a bilinear 2 × 2.
const DOWN_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_src;
uniform vec2 u_texel;
out vec4 o;
void main() {
  vec2 uv = v_ndc * 0.5 + 0.5;
  vec3 s = texture(u_src, uv).rgb * 4.0;
  s += texture(u_src, uv + u_texel * vec2(-1.0, -1.0)).rgb;
  s += texture(u_src, uv + u_texel * vec2(1.0, -1.0)).rgb;
  s += texture(u_src, uv + u_texel * vec2(-1.0, 1.0)).rgb;
  s += texture(u_src, uv + u_texel * vec2(1.0, 1.0)).rgb;
  o = vec4(s / 8.0, 1.0);
}
`;

const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_src;
uniform vec2 u_step;
uniform float u_sigma;
uniform int u_radius;
out vec4 o;
void main() {
  vec2 uv = v_ndc * 0.5 + 0.5;
  vec3 s = vec3(0.0);
  float ws = 0.0;
  for (int i = -u_radius; i <= u_radius; i++) {
    float x = float(i);
    float w = exp(-0.5 * x * x / (u_sigma * u_sigma));
    s += texture(u_src, uv + u_step * x).rgb * w;
    ws += w;
  }
  o = vec4(s / ws, 1.0);
}
`;

const HIGHPASS_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_src;
uniform sampler2D u_blurX;
uniform sampler2D u_blurY;
out vec4 o;
void main() {
  vec2 uv = v_ndc * 0.5 + 0.5;
  vec3 b = texture(u_src, uv).rgb;
  o = vec4(max(b - max(texture(u_blurX, uv).rgb, texture(u_blurY, uv).rgb), vec3(0.0)), 1.0);
}
`;

const STREAK_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_src;
uniform vec2 u_step;
uniform float u_fall;
out vec4 o;
void main() {
  vec2 vuv = v_ndc * 0.5 + 0.5;
  vec3 s = vec3(0.0);
  float ws = 0.0;
  float w = 1.0;
  for (int i = 0; i < 4; i++) {
    vec2 uv = vuv - u_step * float(i);
    // Outside the frame there is no light: clamp-to-edge would smear the border.
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    s += texture(u_src, uv).rgb * w * inside;
    ws += w;
    w *= u_fall;
  }
  o = vec4(s / ws, 1.0);
}
`;

const ADD_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_src;
uniform vec3 u_gain;
out vec4 o;
void main() { o = vec4(texture(u_src, v_ndc * 0.5 + 0.5).rgb * u_gain, 0.0); }
`;

/** Glint light of the HDR render `src` (premultiplied linear, W × H), as a texture of the same uv. */
export function renderGlint(kit: HdrKit, src: WebGLTexture, W: number, H: number, p: GlintParams): WebGLTexture {
	const { gl } = kit;
	const base = Math.max(0, Math.round(Math.log2(Math.max(1, p.pxScale))));
	const grid = 2 ** base;
	const levelFor = (sigma: number, min: number) =>
		base + Math.min(MAX_LEVEL, Math.max(0, Math.floor(Math.log2(Math.max(sigma / min, 1)))));
	const radius = Math.max(0, p.radiusPx) / grid;
	const detail = Math.max(1, p.detailPx / grid);
	const rays = Math.round(p.rays);
	const sl = levelFor(detail, DETAIL_SIGMA);
	const len = p.lengthPx / 2 ** sl;
	const streaking = rays > 0 && len > 1;
	const bloom = (
		radius > 0
			? ([
					[radius * 0.3, 0.4, 2],
					[radius, 0.3, 3],
				] as const)
			: []
	).map(([sigma, gain, slot]) => ({ sigma, gain, slot, level: levelFor(sigma, MIP_SIGMA / 2) }));
	const deepest = Math.max(base, ...bloom.map((b) => b.level), streaking ? sl : base);
	const size = (level: number): [number, number] => [
		Math.max(1, Math.ceil(W / 2 ** level)),
		Math.max(1, Math.ceil(H / 2 ** level)),
	];
	const target = (level: number, slot: number) => {
		const [w, h] = size(level);
		return { tex: kit.target(`glint:${level}:${slot}`, w, h), w, h };
	};

	const out = target(base, 0);
	const bright = target(base, 1);
	runPass(kit, kit.program('glint:bright', BRIGHT_FS), bright.tex, bright.w, bright.h, (u) => {
		bindTexture(gl, 0, src, u('u_src'));
		gl.uniform1f(u('u_threshold'), Math.max(0, p.threshold));
		gl.uniform1f(u('u_exposure'), p.exposure);
		gl.uniform1i(u('u_factor'), grid);
	});
	const mips: { tex: WebGLTexture; w: number; h: number }[] = [];
	mips[base] = bright;
	for (let l = base + 1; l <= deepest; l++) {
		const t = target(l, 1);
		const from = mips[l - 1]!;
		runPass(kit, kit.program('glint:down', DOWN_FS), t.tex, t.w, t.h, (u) => {
			bindTexture(gl, 0, from.tex, u('u_src'));
			gl.uniform2f(u('u_texel'), 1 / from.w, 1 / from.h);
		});
		mips[l] = t;
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, kit.fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
	gl.viewport(0, 0, out.w, out.h);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	const k = Math.max(0, p.intensity);
	const addInto = (tex: WebGLTexture, gain: number) => {
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE);
		runPass(kit, kit.program('glint:add', ADD_FS), out.tex, out.w, out.h, (u) => {
			bindTexture(gl, 0, tex, u('u_src'));
			gl.uniform3f(u('u_gain'), p.tint[0] * k * gain, p.tint[1] * k * gain, p.tint[2] * k * gain);
		});
		gl.disable(gl.BLEND);
	};
	const blurProg = kit.program('glint:blur', BLUR_FS);
	const blur1D = (
		from: { tex: WebGLTexture; w: number; h: number },
		level: number,
		slot: number,
		sigma: number,
		axis: 0 | 1,
	) => {
		const dst = target(level, slot);
		const sg = Math.max(0.5, sigma);
		runPass(kit, blurProg, dst.tex, dst.w, dst.h, (u) => {
			bindTexture(gl, 0, from.tex, u('u_src'));
			gl.uniform1f(u('u_sigma'), sg);
			gl.uniform1i(u('u_radius'), Math.ceil(3 * sg));
			gl.uniform2f(u('u_step'), axis === 0 ? 1 / from.w : 0, axis === 1 ? 1 / from.h : 0);
		});
		return dst;
	};
	for (const { sigma, gain, slot, level } of bloom) {
		const s = sigma / 2 ** (level - base);
		const a = blur1D(mips[level]!, level, 9, s, 0);
		const b = blur1D(a, level, slot, s, 1);
		addInto(b.tex, gain);
	}
	if (streaking) {
		const sigma = detail / 2 ** (sl - base);
		const blurX = blur1D(mips[sl]!, sl, 6, sigma, 0);
		const blurY = blur1D(mips[sl]!, sl, 8, sigma, 1);
		const peaks = target(sl, 7);
		runPass(kit, kit.program('glint:high', HIGHPASS_FS), peaks.tex, peaks.w, peaks.h, (u) => {
			bindTexture(gl, 0, mips[sl]!.tex, u('u_src'));
			bindTexture(gl, 1, blurX.tex, u('u_blurX'));
			bindTexture(gl, 2, blurY.tex, u('u_blurY'));
		});
		const fall = STREAK_TAIL ** (1 / len);
		const passes = Math.max(1, Math.ceil(Math.log(len + 1) / Math.log(4)));
		let kernelSum = 1;
		for (let i = 0; i < passes; i++) {
			const f = fall ** 4 ** i;
			kernelSum *= 1 + f + f * f + f * f * f;
		}
		const ping = [target(sl, 4), target(sl, 5)];
		const streak = kit.program('glint:streak', STREAK_FS);
		for (let r = 0; r < rays; r++) {
			const a = p.angle + (r * 2 * Math.PI) / rays;
			const dx = Math.cos(a) / peaks.w;
			const dy = Math.sin(a) / peaks.h;
			let from = peaks.tex;
			for (let i = 0; i < passes; i++) {
				const stride = 4 ** i;
				const to = ping[i % 2]!;
				const read = from;
				runPass(kit, streak, to.tex, to.w, to.h, (u) => {
					bindTexture(gl, 0, read, u('u_src'));
					gl.uniform2f(u('u_step'), dx * stride, dy * stride);
					gl.uniform1f(u('u_fall'), fall ** stride);
				});
				from = to.tex;
			}
			addInto(from, (STREAK_PEAK * kernelSum) / Math.max(1, sigma));
		}
	}
	gl.activeTexture(gl.TEXTURE0);
	return out.tex;
}

// ---------- environments ----------

/** Levels of the prefiltered map and the roughness each holds; a lookup interpolates between them. */
export const ENV_ROUGHNESS = [0, 0.05, 0.12, 0.25, 0.4, 0.6, 0.8, 1] as const;
const ENV_WIDTH = 2048;
const ENV_HEIGHT = 1024;

const DIR_GLSL = /* glsl */ `
const float PI = 3.14159265;
vec3 dirOfUv(vec2 uv) {
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (0.5 - uv.y) * PI;
  float c = cos(lat);
  return vec3(sin(lon) * c, -sin(lat), cos(lon) * c);
}
vec2 uvOfDir(vec3 d) {
  float lat = asin(clamp(-d.y, -1.0, 1.0));
  float lon = atan(d.x, d.z);
  return vec2(fract(0.5 + lon / (2.0 * PI)), 0.5 - lat / PI);
}
`;

const PRESET_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform int u_preset;
out vec4 o;
${glsl([GLSL_HASH, GLSL_UV, GLSL_COLOR, GLSL_TL_ENV])}
${DIR_GLSL.replace('const float PI = 3.14159265;', 'const float PI = FX_PI;')}
void main() {
  vec3 d = dirOfUv(vec2(v_ndc.x * 0.5 + 0.5, v_ndc.y * 0.5 + 0.5));
  // The chunk's z points at the viewer, ours away from it.
  o = vec4(min(tl_env(u_preset, vec3(d.x, d.y, -d.z), 0.0, 0.0), vec3(60000.0)), 1.0);
}
`;

const COPY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_src;
uniform float u_lod;
uniform int u_srgb;
out vec4 o;
${glsl([GLSL_COLOR])}
void main() {
  vec2 uv = v_ndc * 0.5 + 0.5;
  vec3 c = textureLod(u_src, uv, u_lod).rgb;
  o = vec4(u_srgb == 1 ? fx_srgbToLinear(c) : c, 1.0);
}
`;

// GGX importance sampling (Karis, "Real Shading in Unreal Engine 4", 2013) with Hammersley points: deterministic, and
// the source mip of each sample is chosen by its solid angle (Křivánek and Colbert, 2008) so few samples stay smooth.
const PREFILTER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_src;
uniform float u_rough;
uniform int u_samples;
uniform float u_srcTexels;
out vec4 o;
${DIR_GLSL}
float radicalInverse(uint b) {
  b = (b << 16u) | (b >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return float(b) * 2.3283064365386963e-10;
}
void main() {
  vec3 N = dirOfUv(vec2(v_ndc.x * 0.5 + 0.5, v_ndc.y * 0.5 + 0.5));
  vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  float a = u_rough * u_rough;
  float a2 = a * a;
  vec3 sum = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < u_samples; i++) {
    vec2 xi = vec2(float(i) / float(u_samples), radicalInverse(uint(i)));
    float phi = 2.0 * PI * xi.x;
    float cosH = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    float sinH = sqrt(max(0.0, 1.0 - cosH * cosH));
    vec3 H = T * (cos(phi) * sinH) + B * (sin(phi) * sinH) + N * cosH;
    vec3 L = reflect(-N, H);
    float nl = dot(N, L);
    if (nl <= 0.0) continue;
    float d = cosH * cosH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * d * d);
    float pdf = max(D / 4.0, 1e-5);
    float saSample = 1.0 / (float(u_samples) * pdf);
    float saTexel = 4.0 * PI / u_srcTexels;
    float lod = 0.5 * log2(max(saSample / saTexel, 1.0)) + 0.5;
    sum += textureLod(u_src, uvOfDir(L), lod).rgb * nl;
    ws += nl;
  }
  o = vec4(sum / max(ws, 1e-4), 1.0);
}
`;

// The cosine convolution of the environment: the mean radiance over the hemisphere around N (Lambert's E / π).
const IRRADIANCE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_src;
uniform float u_lod;
out vec4 o;
${DIR_GLSL}
void main() {
  vec3 N = dirOfUv(vec2(v_ndc.x * 0.5 + 0.5, v_ndc.y * 0.5 + 0.5));
  vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  vec3 sum = vec3(0.0);
  const int M = 12;
  const int K = 24;
  for (int j = 0; j < M; j++) {
    float u = (float(j) + 0.5) / float(M);
    float cosT = sqrt(1.0 - u);
    float sinT = sqrt(u);
    for (int i = 0; i < K; i++) {
      float phi = 2.0 * PI * (float(i) + 0.5) / float(K);
      vec3 L = T * (cos(phi) * sinT) + B * (sin(phi) * sinT) + N * cosT;
      sum += textureLod(u_src, uvOfDir(L), u_lod).rgb;
    }
  }
  o = vec4(sum / float(M * K), 1.0);
}
`;

export type EnvMaps = {
	/** Prefiltered radiance: level k holds roughness `ENV_ROUGHNESS[k]`. */
	radiance: WebGLTexture;
	/** Cosine-convolved irradiance. */
	irradiance: WebGLTexture;
};

export type EnvSource =
	| { kind: 'preset'; preset: number }
	| { kind: 'float'; width: number; height: number; data: Float32Array }
	| { kind: 'image'; image: TexImageSource };

function mipTexture(gl: WebGL2RenderingContext, w: number, h: number, levels: number): WebGLTexture {
	const t = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, w, h);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return t;
}

/** Prefilters an environment: reflections by roughness, irradiance by the cosine lobe. Slow: callers cache. */
export function buildEnvMaps(kit: HdrKit, source: EnvSource): EnvMaps {
	const { gl } = kit;
	gl.disable(gl.DEPTH_TEST);
	gl.disable(gl.BLEND);
	gl.disable(gl.SCISSOR_TEST);
	// The source, with mips for the prefilter's lookups.
	const fullLevels = Math.floor(Math.log2(ENV_WIDTH)) + 1;
	const src = mipTexture(gl, ENV_WIDTH, ENV_HEIGHT, fullLevels);
	if (source.kind === 'preset') {
		runPass(kit, kit.program('env:preset', PRESET_FS), src, ENV_WIDTH, ENV_HEIGHT, (u) => {
			gl.uniform1i(u('u_preset'), source.preset);
		});
	} else {
		const raw = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, raw);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
		if (source.kind === 'float') {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, source.width, source.height, 0, gl.RGBA, gl.FLOAT, source.data);
		} else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source.image);
		gl.generateMipmap(gl.TEXTURE_2D);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		// Rows run top first in both sources, and v = 0 is the zenith everywhere: as `envUV` reads it.
		const srcW = source.kind === 'float' ? source.width : (source.image as { width: number }).width;
		runPass(kit, kit.program('env:copy', COPY_FS), src, ENV_WIDTH, ENV_HEIGHT, (u) => {
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, raw);
			gl.uniform1i(u('u_src'), 0);
			gl.uniform1f(u('u_lod'), Math.max(0, Math.log2(srcW / ENV_WIDTH)));
			gl.uniform1i(u('u_srgb'), source.kind === 'image' ? 1 : 0);
		});
		gl.deleteTexture(raw);
	}
	gl.bindTexture(gl.TEXTURE_2D, src);
	gl.generateMipmap(gl.TEXTURE_2D);
	const levels = ENV_ROUGHNESS.length;
	const radiance = mipTexture(gl, ENV_WIDTH, ENV_HEIGHT, levels);
	const copy = kit.program('env:copy', COPY_FS);
	for (let l = 0; l < 2; l++)
		runPass(
			kit,
			copy,
			radiance,
			ENV_WIDTH >> l,
			ENV_HEIGHT >> l,
			(u) => {
				gl.activeTexture(gl.TEXTURE0);
				gl.bindTexture(gl.TEXTURE_2D, src);
				gl.uniform1i(u('u_src'), 0);
				gl.uniform1f(u('u_lod'), l);
				gl.uniform1i(u('u_srgb'), 0);
			},
			l,
		);
	const pre = kit.program('env:prefilter', PREFILTER_FS);
	for (let l = 2; l < levels; l++)
		runPass(
			kit,
			pre,
			radiance,
			ENV_WIDTH >> l,
			ENV_HEIGHT >> l,
			(u) => {
				gl.activeTexture(gl.TEXTURE0);
				gl.bindTexture(gl.TEXTURE_2D, src);
				gl.uniform1i(u('u_src'), 0);
				gl.uniform1f(u('u_rough'), ENV_ROUGHNESS[l]!);
				gl.uniform1i(u('u_samples'), l <= 3 ? 48 : 96);
				gl.uniform1f(u('u_srcTexels'), ENV_WIDTH * ENV_HEIGHT);
			},
			l,
		);
	const irradiance = mipTexture(gl, 64, 32, 1);
	runPass(kit, kit.program('env:irradiance', IRRADIANCE_FS), irradiance, 64, 32, (u) => {
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, src);
		gl.uniform1i(u('u_src'), 0);
		gl.uniform1f(u('u_lod'), 5);
	});
	gl.deleteTexture(src);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	return { radiance, irradiance };
}

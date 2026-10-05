// Sapphire Blur+Sharpen — the iris ("circle of confusion") gather shared by the defocus effects (S_RackDefocus,
// S_AdvancedDefocus, S_DefocusPrism, S_RackDfComp, S_ZDefocus, S_FreeLens).
//
// How it works: the picture is prepared once (edge mode, chroma distort, mono, Boost Highlights, Use Gamma) into a
// half-float texture, downscaled on a 3×3 tent pyramid until the iris radius is ≤ ~10 texels, then every output texel
// GATHERS n samples laid on a Vogel (golden-angle) spiral that is warped into the iris shape: polygon with Roundness
// (star < 0 < polygon < 1 = circle < flower), Rotate, Rel Height; each sample is weighted by the Bokeh ring/soft-edge
// profile, Lens Noise, optional lens texture / custom lens picture, optical vignette and matte-box crops. Colour
// fringing samples the three channels at different radii; DefocusPrism weights each channel by its own ring. With
// gamma > 1 and half-float intermediates the bright points keep their energy and bloom into clean iris shapes
// (real bokeh), unlike a gaussian. Cost: n ≤ 400 taps on a ≤ 1/2^k texture, so 1080p previews stay interactive.
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_NOISE } from '../glsl/noise.ts';
import { fxParam } from '../params.ts';
import type { FxUniformValue, GlslChunk, ShaderPass } from '../shader.ts';
import {
	choiceIndex,
	definesChunk,
	GLSL_SBS_COMMON,
	levelFor,
	num,
	type SbsPlan,
	sNum,
	sSize,
} from './common.ts';

/** Iris radius (canvas px) per Sapphire "Defocus Width" unit: the width is the iris DIAMETER in Sapphire units. */
export const DEFOCUS_RADIUS_PER_UNIT = 0.5;
/** Target iris radius in texels of the gathered pyramid level. */
const GATHER_TARGET = 10;
const MAX_TAPS = 400;

// ---------------------------------------------------------------- params

/** Shape popup of RackDefocus/DefocusPrism/ZDefocus/RackDfComp: Circle, 3…12 sides. */
export const IRIS_SHAPES = [
	'circle',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	'10',
	'11',
	'12',
] as const;
export const irisShapeParam = (name = 'shape', label = 'Shape', def: (typeof IRIS_SHAPES)[number] = 'circle') =>
	fxParam.choice(
		name,
		label,
		IRIS_SHAPES,
		IRIS_SHAPES.map((s) => (s === 'circle' ? 'Circle' : `${s} sides`)),
		def,
	);
/** Number of sides of a Shape popup value (0 = circle). */
export const irisSides = (v: unknown, def: (typeof IRIS_SHAPES)[number] = 'circle'): number => {
	const i = choiceIndex(v, IRIS_SHAPES, def);
	return i === 0 ? 0 : i + 2;
};

/** Roundness, Rotate, Bokeh (the common iris params). */
export const irisLookParams = (roundness = 0, bokeh = 0): ParamSpec[] => [
	sNum('roundness', 'Roundness', roundness, { softMin: -1, softMax: 2, step: 0.01 }),
	fxParam.angle('rotate', 'Rotate', 0),
	sNum('bokeh', 'Bokeh', bokeh, { softMin: -1, softMax: 1, step: 0.01 }),
];
/** Lens Noise, Noise Freq, Noise Freq Rel X, Noise Seed. */
export const lensNoiseParams = (): ParamSpec[] => [
	sNum('lensNoise', 'Lens Noise', 0, { min: 0, softMax: 2, step: 0.01 }),
	sNum('noiseFreq', 'Noise Freq', 40, { min: 0.01, softMax: 200, step: 0.1 }),
	sNum('noiseFreqRelX', 'Noise Freq Rel X', 1, { min: 0.01, softMax: 4, step: 0.01 }),
	sNum('noiseSeed', 'Noise Seed', 0.123, { min: 0, softMax: 10, step: 0.001 }),
];
/** Use Gamma, Boost Highlights, Hilight Threshold. */
export const highlightParams = (gamma = 1, boost = 0, thresholdLabel = 'Hilight Threshold'): ParamSpec[] => [
	sNum('useGamma', 'Use Gamma', gamma, { min: 0.1, softMax: 4, step: 0.01 }),
	sNum('boostHighlights', 'Boost Highlights', boost, { min: 0, softMax: 4, step: 0.01 }),
	sNum('hilightThreshold', thresholdLabel, 0.9, { min: 0, softMax: 1, step: 0.01 }),
];
export const defocusWidthParam = (def = 0.088, name = 'defocusWidth', label = 'Defocus Width') =>
	sSize(name, label, def, 1);

// ---------------------------------------------------------------- iris config

/** Everything the gather needs about the iris (per instance, from params). */
export type IrisConfig = {
	/** 0 = circle, else polygon sides. */
	sides: number;
	roundness: number;
	/** Degrees. */
	rotate: number;
	bokeh: number;
	bokehSoftness?: number;
	bokehCenter?: number;
	notchDepth?: number;
	notchAngle?: number;
	lensNoise?: number;
	noiseFreq?: number;
	noiseFreqRelX?: number;
	noiseSeed?: number;
	/** Per-channel radius multipliers (colour fringing); undefined = none. */
	fringe?: readonly [number, number, number];
	/** DefocusPrism rings: separation and thickness. */
	prism?: { sep: number; thick: number };
	/** S_AdvancedDefocus extras. */
	opticalVignette?: number;
	vignetteSize?: number;
	matteBox?: readonly [number, number, number, number];
	/** Lens texture (media param `lensTexture`): scale, rel Y, rotate (deg), intensity, shift. */
	texture?: { scale: number; relY: number; rotate: number; intensity: number; shift: readonly [number, number] };
	/** Custom lens picture (media param `customLens`). */
	customLens?: boolean;
};

/** The iris of the common params (Shape/Roundness/Rotate/Bokeh/Lens Noise…). */
export function irisFromParams(p: EffectParams, sides: number): IrisConfig {
	return {
		sides,
		roundness: num(p.roundness),
		rotate: num(p.rotate),
		bokeh: num(p.bokeh),
		lensNoise: num(p.lensNoise),
		noiseFreq: num(p.noiseFreq, 40),
		noiseFreqRelX: num(p.noiseFreqRelX, 1),
		noiseSeed: num(p.noiseSeed, 0.123),
	};
}

/** Colour fringing multipliers ("Color Fringing", Red/Blue or Green/Magenta). */
export function fringeOf(amount: number, greenMagenta = false): [number, number, number] | undefined {
	if (Math.abs(amount) < 1e-4) return undefined;
	const k = Math.min(0.9, Math.abs(amount) * 0.15);
	if (greenMagenta) return amount > 0 ? [1 + k, 1, 1 + k] : [1, 1 + k, 1];
	return amount > 0 ? [1 - k, 1, 1 + k] : [1 + k, 1, 1 - k];
}

function irisDefines(c: IrisConfig): string {
	const d: string[] = [];
	if (c.fringe) d.push('#define SBS_FRINGE 1');
	if (c.prism) d.push('#define SBS_PRISM 1');
	if ((c.lensNoise ?? 0) > 0) d.push('#define SBS_NOISE 1');
	if (c.opticalVignette || c.matteBox?.some((x) => x > 0)) d.push('#define SBS_CROP 1');
	if (c.texture && c.texture.intensity > 0) d.push('#define SBS_TEXTURE 1');
	if (c.customLens) d.push('#define SBS_CUSTOM 1');
	return d.length ? `${d.join('\n')}\n` : '';
}

/** Uniforms of the iris functions (every pass that includes GLSL_SBS_IRIS needs them). */
export function irisUniforms(c: IrisConfig): Record<string, FxUniformValue> {
	const prism = c.prism ?? { sep: 0, thick: 1 };
	const tex = c.texture ?? { scale: 1, relY: 1, rotate: 0, intensity: 0, shift: [0, 0] as const };
	return {
		u_irisA: [c.sides, c.roundness, (c.rotate * Math.PI) / 180, c.bokeh],
		u_irisB: [c.bokehSoftness ?? 1, c.bokehCenter ?? 0.5, c.notchDepth ?? 0, c.notchAngle ?? 0.05],
		u_irisN: [c.lensNoise ?? 0, c.noiseFreq ?? 40, c.noiseFreqRelX ?? 1, c.noiseSeed ?? 0.123],
		u_irisFringe: (c.fringe ?? [1, 1, 1]) as [number, number, number],
		u_irisPrism: [prism.sep, Math.max(0.01, prism.thick)],
		u_irisCrop: [c.opticalVignette ?? 0, Math.max(1, c.vignetteSize ?? 1)],
		u_irisBox: (c.matteBox ?? [0, 0, 0, 0]) as [number, number, number, number],
		u_irisTex: [Math.max(0.1, tex.scale), Math.max(0.01, tex.relY), (tex.rotate * Math.PI) / 180, tex.intensity],
		u_irisTexShift: [tex.shift[0], tex.shift[1]],
	};
}

// ---------------------------------------------------------------- GLSL

/**
 * `sapphire-blur-sharpen/iris`: the iris boundary, ring profile, noise and crops, `sbs_irisAt(s, px)` (per-channel
 * weight of kernel point s, for Show Shape) and `sbs_gather(t, uv, radiusTexels, count, mode)`. Feature switches are
 * `#define`s emitted by `irisDefines` (programs are cached per source, so each variant compiles once).
 */
export const GLSL_SBS_IRIS: GlslChunk = {
	name: 'sapphire-blur-sharpen/iris',
	deps: [GLSL_SBS_COMMON, GLSL_NOISE, GLSL_COLOR],
	source: /* glsl */ `
const float SBS_GOLDEN = 2.39996322972865;
const float SBS_PI = 3.14159265358979;
// Boundary radius (1 = circumradius) of the iris at angle th: polygon → Roundness mix with the unit circle; notches.
float sbs_irisBoundary(float th) {
  float n = u_irisA.x;
  if (n < 2.5) return 1.0;
  float seg = 2.0 * SBS_PI / n;
  float ph = mod(th - u_irisA.z, seg) - 0.5 * seg;
  float poly = cos(0.5 * seg) / cos(ph);
  float b = poly + u_irisA.y * (1.0 - poly);
  if (u_irisB.z > 0.0) {
    float fromVertex = 0.5 * seg - abs(ph);
    b *= 1.0 - u_irisB.z * 0.35 * (1.0 - smoothstep(0.0, max(u_irisB.w, 1.0e-3) * seg, fromVertex));
  }
  return max(b, 0.02);
}
// Radial profile at normalised radius r (0 centre … 1 edge): Bokeh > 0 softens the edge, < 0 darkens the centre.
float sbs_irisProfile(float r) {
  float bk = u_irisA.w;
  if (bk > 0.0) return 1.0 - smoothstep(1.0 - min(bk, 1.0) * u_irisB.x - 1.0e-3, 1.0001, r) * min(bk, 1.0);
  if (bk < 0.0) {
    float c = clamp(u_irisB.y, 0.01, 0.99);
    float s = max(u_irisB.x, 0.02);
    float ring = smoothstep(c - s * c, c + s * (1.0 - c), r);
    return mix(1.0, ring, min(-bk, 1.0));
  }
  return 1.0;
}
float sbs_irisNoise(vec2 s) {
#ifdef SBS_NOISE
  vec2 q = s * u_irisN.y * 0.1 * vec2(u_irisN.z, 1.0);
  float n = fx_valueNoise(q, fract(u_irisN.w * 0.6180339887));
  return max(0.0, 1.0 + u_irisN.x * n);
#else
  return 1.0;
#endif
}
float sbs_irisTexture(vec2 s) {
  float w = 1.0;
#ifdef SBS_TEXTURE
  if (u_lensTexture_size.x > 0.0) {
    float c = cos(u_irisTex.z), sn = sin(u_irisTex.z);
    vec2 q = mat2(c, sn, -sn, c) * s;
    q = q / (2.0 * u_irisTex.x) * vec2(1.0, 1.0 / u_irisTex.y) + 0.5 - u_irisTexShift * 0.1;
    w = mix(1.0, fx_luma(texture(u_lensTexture, fract(q)).rgb), clamp(u_irisTex.w, 0.0, 1.0));
  }
#endif
#ifdef SBS_CUSTOM
  if (u_customLens_size.x > 0.0) {
    float c = cos(u_irisA.z), sn = sin(u_irisA.z);
    vec2 q = mat2(c, -sn, sn, c) * s * 0.5 + 0.5;
    vec4 k = texture(u_customLens, q);
    w *= fx_luma(k.rgb) * (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0))) ? 0.0 : 1.0);
  }
#endif
  return w;
}
// Optical vignette (cat's eye) and matte-box crops for an output pixel at layer-norm position n.
float sbs_irisCrop(vec2 s, vec2 n) {
#ifdef SBS_CROP
  vec2 p = n * 2.0 - 1.0;
  if (abs(u_irisCrop.x) > 0.0 && length(s - p * u_irisCrop.x) > u_irisCrop.y) return 0.0;
  if (s.x > 1.0 - u_irisBox.x * max(0.0, 1.0 - n.x) * 2.0) return 0.0;
  if (-s.x > 1.0 - u_irisBox.y * max(0.0, n.x) * 2.0) return 0.0;
  if (s.y > 1.0 - u_irisBox.z * max(0.0, 1.0 - n.y) * 2.0) return 0.0;
  if (-s.y > 1.0 - u_irisBox.w * max(0.0, n.y) * 2.0) return 0.0;
#endif
  return 1.0;
}
// DefocusPrism: weight of each channel's ring at normalised radius r.
vec3 sbs_prismRings(float r) {
  float h = 0.5 * min(u_irisPrism.y, 2.0);
  float sep = u_irisPrism.x;
  float top = max(1.0 - h, 0.0);
  vec3 k = sep >= 0.0 ? vec3(0.0, 1.0, 2.0) : vec3(2.0, 1.0, 0.0);
  vec3 rho = top - k * abs(sep) * top * 0.5;
  vec3 d = abs(vec3(r) - rho);
  return 1.0 - smoothstep(vec3(h * 0.55), vec3(h + 1.0e-3), d);
}
// Per-channel weight of the iris at kernel point s (|s| ≤ 1 = circumradius); aa = smoothing width (kernel units).
vec3 sbs_irisAt(vec2 s, float aa) {
  float th = atan(s.y, s.x);
  float b = sbs_irisBoundary(th);
#ifdef SBS_CUSTOM
  b = 1.0;
#endif
  float r = length(s) / b;
  float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  float w = inside * sbs_irisProfile(min(r, 1.0)) * sbs_irisNoise(s) * sbs_irisTexture(s);
#ifdef SBS_PRISM
  return w * sbs_prismRings(r);
#else
  return vec3(w);
#endif
}
// Gather of premultiplied t at uv over the iris with radius rad (texels of t, x/y), n taps; edge mode at the box.
vec4 sbs_gather(sampler2D t, vec2 uv, vec2 rad, float count, int mode) {
  vec2 texel = 1.0 / vec2(textureSize(t, 0));
  int n = int(clamp(count, 1.0, float(${MAX_TAPS})));
  vec2 pn = sbs_layerNorm(uv);
  vec4 sum = vec4(0.0);
  vec4 wsum = vec4(0.0);
  float wall = 0.0;
  for (int i = 0; i < ${MAX_TAPS}; i++) {
    if (i >= n) break;
    float rr = sqrt((float(i) + 0.5) / float(n));
    float a = float(i) * SBS_GOLDEN;
    vec2 dir = vec2(cos(a), sin(a));
    float b = sbs_irisBoundary(a);
#ifdef SBS_CUSTOM
    b = 1.0;
#endif
    vec2 s = rr * b * dir;
    float w = b * b * sbs_irisProfile(rr) * sbs_irisNoise(s) * sbs_irisTexture(s);
    wall += w;
    w *= sbs_irisCrop(s, pn);
    vec2 o = s * rad * texel;
#ifdef SBS_PRISM
    vec3 wc = w * sbs_prismRings(rr);
    vec4 c = sbs_tex(t, uv + o, mode);
    sum += vec4(c.rgb * wc, c.a * w);
    wsum += vec4(wc, w);
#elif defined(SBS_FRINGE)
    vec4 cr = sbs_tex(t, uv + o * u_irisFringe.r, mode);
    vec4 cg = sbs_tex(t, uv + o * u_irisFringe.g, mode);
    vec4 cb = sbs_tex(t, uv + o * u_irisFringe.b, mode);
    sum += vec4(cr.r, cg.g, cb.b, cg.a) * w;
    wsum += vec4(w);
#else
    sum += sbs_tex(t, uv + o, mode) * w;
    wsum += vec4(w);
#endif
  }
#ifdef SBS_CROP
  // Cropped highlights lose light (Sapphire: the vignette darkens the output).
  return sum / max(vec4(wall), vec4(1.0e-6)) * (wsum.a > 0.0 ? 1.0 : 0.0);
#else
  return sum / max(wsum, vec4(1.0e-6));
#endif
}
`,
};

/** Show-shape view: the iris drawn over the layer (80 % of its height), black around. */
export const IRIS_SHAPE_VIEW = /* glsl */ `
vec4 sbs_shapeView(float relY, float zoom) {
  vec2 n = sbs_layerNorm(v_uv) - 0.5;
  vec2 s = n * vec2(u_box.z / u_box.w, 1.0) * 2.0 / zoom;
  s.y /= max(relY, 0.01);
  vec3 w = sbs_irisAt(s, 2.0 / (u_box.w * zoom));
  return vec4(clamp(w, 0.0, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------- planning

export type GatherSpec = {
	/** Prepared (premultiplied, usually half-float) picture to defocus. */
	input: string;
	output: string;
	/** Iris circumradius in CANVAS px, x and y (Rel Height / Defocus Rel). */
	radiusX: number;
	radiusY: number;
	iris: IrisConfig;
	/** GLSL edge mode. */
	edge: number;
	/** Extra downscale steps (S_AdvancedDefocus "Resolution"). */
	extraLevels?: number;
	/** Extra `#define` lines (they precede the iris chunk). */
	defines?: string;
	/** Fragment body: default `fragColor = sbs_gather(...)`. Receives the texture expression. */
	body?: (tex: string) => string;
	include?: readonly GlslChunk[];
	uniforms?: Record<string, FxUniformValue>;
	/** Cap of the downscale (pyramid) level. */
	maxLevel?: number;
};

/** Plans one iris gather (pyramid level by radius, tap count by area). Returns the output and its scale. */
export function gatherPass(plan: SbsPlan, g: GatherSpec): { output: string; scale: number; level: number } {
	const fr = g.iris.fringe ? Math.max(...g.iris.fringe) : 1;
	const r = Math.max(g.radiusX, g.radiusY) * fr;
	const k = Math.min(g.maxLevel ?? 6, levelFor(r, GATHER_TARGET) + (g.extraLevels ?? 0));
	const scale = 1 / 2 ** k;
	const tex = plan.level(g.input, k);
	const rx = g.radiusX * scale;
	const ry = g.radiusY * scale;
	const area = Math.PI * Math.max(rx, 0.5) * Math.max(ry, 0.5) * fr * fr;
	const count = Math.min(MAX_TAPS, Math.max(12, Math.ceil(area * 1.1)));
	const radiusTiny = Math.max(rx, ry) < 0.35;
	const pass: ShaderPass = {
		output: g.output,
		include: [definesChunk(irisDefines(g.iris) + (g.defines ?? '')), GLSL_SBS_IRIS, ...(g.include ?? [])],
		frag: `
void main() {
${
	g.body
		? g.body(`u_${tex}`)
		: radiusTiny
			? `  fragColor = sbs_tex(u_${tex}, v_uv, u_gEdge);`
			: `  fragColor = sbs_gather(u_${tex}, v_uv, u_gRadius, u_gCount, u_gEdge);`
}
}`,
		scale,
		format: 'rgba16f',
		uniforms: {
			...irisUniforms(g.iris),
			u_gRadius: [rx, ry],
			u_gCount: count,
			u_gEdge: { int: g.edge },
			...(g.uniforms ?? {}),
		},
	};
	plan.pass(pass);
	return { output: g.output, scale, level: k };
}

/** The iris uniforms + defines for a final pass that draws Show Shape. */
export function shapeViewPassParts(iris: IrisConfig) {
	return { defines: definesChunk(irisDefines(iris)), uniforms: irisUniforms(iris) };
}

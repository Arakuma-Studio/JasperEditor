// Object mattes (parity workstream `roto`): the output side of the Roto Brush and of face tracking. The mattes are
// computed by the engine (graph cut + SAM 2.1 + edge matting, docs/wp-notes/roto.md) and bound per frame through
// `GpuEffect.mattes`; these effects refine and apply them live, like After Effects' Roto Brush & Refine Edge matte
// controls (Feather, Contrast, Shift Edge, Reduce Chatter, Motion Blur, Decontaminate Edge Colors) — ported from
// EffectCraft `crates/track/src/roto/refine.rs` + `matting.rs` (MIT OR Apache-2.0, licenses/ported/roto.md) to GLSL.
//
// - Object Matte (`jasper.object-matte`): cuts the clip out by the object (views Final Result, Alpha, Alpha Overlay,
//   Alpha Boundary, Decontamination Map).
// - Object Blur (`jasper.object-blur`): blurs, pixelates or fills the object (or everything but it) — Blur Faces.
//
// Matte states (`u_<matte>_state`): 0 = no object / not computed → the input passes through; 1 = the frame's matte;
// 2 = outside the computed span → Object Matte is transparent there (After Effects), Object Blur changes nothing.
import { OBJECT_BLUR_EFFECT_ID, OBJECT_MATTE_EFFECT_ID } from '../../roto/index.ts';
import type { EffectParams, EffectSpec } from '../effects.ts';
import { defineShaderEffect } from './define.ts';
import { GLSL_BLUR } from './glsl/blur.ts';
import { GLSL_MB } from './glsl/motion-blur.ts';
import { fxParam } from './params.ts';
import type { GlslChunk, ShaderPass } from './shader.ts';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d = false) => (typeof v === 'boolean' ? v : d);

/** Shift Edge: ±100 % moves the edge by 10 px (EffectCraft / After Effects' scale for the Roto Brush matte). */
export const OBJECT_SHIFT_PX_PER_100 = 10;
/** Base radius (px) of the decontamination colour estimates (+ Increase Decontamination Radius). */
export const OBJECT_DECON_RADIUS = 6;
/** Moments grid of the motion-blur velocity estimate (cells per side per matte). */
const MOM = 32;

/** Shared GLSL: matte sampling over the layer box, fractional morphology. */
export const GLSL_OBJECT_MATTE: GlslChunk = {
	name: 'roto/matte',
	source: /* glsl */ `
// The matte value of a bound matte texture at layer-normalised n (0 outside the layer box or without a picture).
float om_sample(sampler2D t, vec2 size, vec2 n) {
  if (size.x < 1.0 || any(lessThan(n, vec2(0.0))) || any(greaterThan(n, vec2(1.0)))) return 0.0;
  return texture(t, n).r;
}
// Grey-scale erosion (dilate = false) or dilation along dir over a fractional radius (texture px), red channel.
float om_morph1d(sampler2D t, vec2 uv, vec2 dir, vec2 texel, float radius, bool dilate) {
  float v = texture(t, uv).r;
  int n = int(ceil(radius));
  for (int i = 1; i <= 128; i++) {
    if (i > n) break;
    float w = clamp(radius - float(i - 1), 0.0, 1.0);
    float a = texture(t, uv + dir * texel * float(i)).r;
    float b = texture(t, uv - dir * texel * float(i)).r;
    float m = dilate ? max(a, b) : min(a, b);
    v = dilate ? max(v, mix(v, m, w)) : min(v, mix(v, m, w));
  }
  return v;
}
// Contrast (0..100 %) around ½ (Refine Edge's Contrast).
float om_contrast(float a, float pc) {
  if (pc <= 0.0) return a;
  return clamp(0.5 + (a - 0.5) / (1.0 - 0.99 * clamp(pc / 100.0, 0.0, 1.0)), 0.0, 1.0);
}
`,
};

/** Morphology (H then V, ping-pong on `name`) by `radiusPx` canvas px: > 0 grows, < 0 shrinks. */
function morphPasses(name: string, radiusPx: number): ShaderPass[] {
	if (Math.abs(radiusPx) < 0.05) return [];
	const r = Math.min(128, Math.abs(radiusPx));
	const frag = /* glsl */ `
void main() {
  float m = om_morph1d(u_${name}, v_uv, u_omDir, u_texel, u_omRadius, u_omDilate);
  fragColor = vec4(m, m, m, 1.0);
}`;
	return [0, 1].map((axis) => ({
		output: name,
		update: true,
		include: [GLSL_OBJECT_MATTE],
		frag,
		uniforms: { u_omDir: axis === 0 ? [1, 0] : [0, 1], u_omRadius: r, u_omDilate: radiusPx > 0 },
	}));
}

/** Gaussian blur (H then V, ping-pong on `name`, at `scale` of the canvas like its first write) with sigma in px of
 * that texture. */
function blurPasses(name: string, sigma: number, scale = 1): ShaderPass[] {
	if (sigma < 0.05) return [];
	const frag = /* glsl */ `
void main() { fragColor = fx_gaussian1d(u_${name}, v_uv, u_omDir, u_texel, u_omSigma); }`;
	return [0, 1].map((axis) => ({
		output: name,
		update: true,
		include: [GLSL_BLUR],
		frag,
		uniforms: { u_omDir: axis === 0 ? [1, 0] : [0, 1], u_omSigma: sigma },
		...(scale < 1 ? { scale } : {}),
	}));
}

/** The object's matte on the canvas (+ Reduce Chatter towards the neighbouring frames), into `output`. */
function basePass(output: string, chatter: boolean): ShaderPass {
	return {
		output,
		include: [GLSL_OBJECT_MATTE],
		frag: /* glsl */ `
void main() {
  vec2 n = fx_layerNorm();
  float m;
  if (u_matte_state < 0.5) m = 1.0;
  else if (u_matte_state > 1.5) m = 0.0;
  else {
    m = om_sample(u_matte, u_matte_size, n);
${
	chatter
		? `    float k = clamp(u_reduceChatter / 100.0, 0.0, 1.0);
    if (k > 0.0) {
      float s = 0.0;
      float c = 0.0;
      if (abs(u_mattePrev_state - 1.0) < 0.5 && u_mattePrev_size.x > 0.0) { s += om_sample(u_mattePrev, u_mattePrev_size, n); c += 1.0; }
      if (abs(u_matteNext_state - 1.0) < 0.5 && u_matteNext_size.x > 0.0) { s += om_sample(u_matteNext, u_matteNext_size, n); c += 1.0; }
      if (c > 0.0) m += (s / c - m) * k * (c / (c + 1.0));
    }`
		: ''
}
  }
  fragColor = vec4(m, m, m, 1.0);
}`,
	};
}

/** Per-cell moments (Σ a·u, Σ a·v, Σ a) of the previous, current and next mattes (3 blocks of MOM × MOM cells). */
function momentPasses(): ShaderPass[] {
	return [
		{
			output: 'omMom',
			size: { width: MOM * 3, height: MOM },
			format: 'rgba16f',
			filter: 'nearest',
			include: [GLSL_OBJECT_MATTE],
			frag: /* glsl */ `
const float OM_MOM = ${MOM.toFixed(1)};
void main() {
  vec2 px = floor(v_uv * u_resolution);
  int block = int(px.x / OM_MOM);
  vec2 cell = vec2(mod(px.x, OM_MOM), px.y);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) {
      vec2 n = (cell + (vec2(float(i), float(j)) + 0.5) / 4.0) / OM_MOM;
      float a = 0.0;
      if (block == 0) { if (abs(u_mattePrev_state - 1.0) < 0.5) a = om_sample(u_mattePrev, u_mattePrev_size, n); }
      else if (block == 1) { if (abs(u_matte_state - 1.0) < 0.5) a = om_sample(u_matte, u_matte_size, n); }
      else { if (abs(u_matteNext_state - 1.0) < 0.5) a = om_sample(u_matteNext, u_matteNext_size, n); }
      acc += vec3(a * n, a);
    }
  fragColor = vec4(acc / 16.0, 1.0);
}`,
		},
		{
			output: 'omCen',
			size: { width: 3, height: 1 },
			format: 'rgba16f',
			filter: 'nearest',
			frag: /* glsl */ `
void main() {
  int block = int(floor(v_uv.x * 3.0));
  vec3 s = vec3(0.0);
  for (int y = 0; y < ${MOM}; y++)
    for (int x = 0; x < ${MOM}; x++) s += texelFetch(u_omMom, ivec2(block * ${MOM} + x, y), 0).rgb;
  // Centroid (layer-normalised) and whether the matte is non-empty.
  fragColor = s.z > 1.0e-4 ? vec4(s.xy / s.z, 1.0, 1.0) : vec4(0.0);
}`,
		},
	];
}

/** Pure background / foreground colour estimates near the edge (decontamination), half resolution, blurred. */
function deconPasses(sigma: number): ShaderPass[] {
	const est = (output: string, bg: boolean): ShaderPass[] => [
		{
			output,
			scale: 0.5,
			include: [GLSL_OBJECT_MATTE],
			frag: /* glsl */ `
void main() {
  vec4 s = fx_unpremultiply(texture(u_source, v_uv));
  float a = om_contrast(texture(u_omMat, v_uv).r, u_contrast);
  float w = ${bg ? 'a < 0.02' : 'a > 0.98'} && s.a > 0.0 ? 1.0 : 0.0;
  fragColor = vec4(s.rgb * w, w);
}`,
		},
		...blurPasses(output, Math.max(1, sigma * 0.5), 0.5),
	];
	return [...est('omBg', true), ...est('omFg', false)];
}

/** Velocity (canvas uv per frame) of the matte from the centroids of the neighbouring frames, in GLSL. */
const GLSL_OM_VELOCITY = /* glsl */ `
vec2 om_velocity() {
  vec4 p = texelFetch(u_omCen, ivec2(0, 0), 0);
  vec4 c = texelFetch(u_omCen, ivec2(1, 0), 0);
  vec4 q = texelFetch(u_omCen, ivec2(2, 0), 0);
  vec2 v = vec2(0.0);
  if (p.z > 0.5 && q.z > 0.5) v = (q.xy - p.xy) * 0.5;
  else if (p.z > 0.5 && c.z > 0.5) v = c.xy - p.xy;
  else if (q.z > 0.5 && c.z > 0.5) v = q.xy - c.xy;
  return v * u_box.zw / u_canvasSize;
}`;

const OBJECT_VIEWS = ['final', 'alpha', 'overlay', 'boundary', 'decontamination'] as const;
const OBJECT_VIEW_LABELS = [
	'Final Result',
	'Alpha',
	'Alpha Overlay',
	'Alpha Boundary',
	'Decontamination Map',
];

const objectMatteParams = [
	fxParam.object('object', 'Object'),
	fxParam.choice('view', 'View', OBJECT_VIEWS, OBJECT_VIEW_LABELS, 'final'),
	fxParam.color('overlayColor', 'Overlay Color', [1, 0, 0, 0.5]),
	fxParam.toggle('invert', 'Invert', false),
	fxParam.pixels('feather', 'Feather', 0, 100, { group: 'Matte' }),
	fxParam.percent('contrast', 'Contrast', 0, { group: 'Matte' }),
	fxParam.number(
		'shiftEdge',
		'Shift Edge',
		0,
		{ min: -100, max: 100, step: 0.1 },
		{
			unit: '%',
			group: 'Matte',
			ui: { control: 'slider', bipolar: true },
		},
	),
	fxParam.percent('reduceChatter', 'Reduce Chatter', 0, { group: 'Matte' }),
	fxParam.toggle('useMotionBlur', 'Use Motion Blur', false, { group: 'Motion Blur' }),
	fxParam.number(
		'shutterAngle',
		'Shutter Angle',
		180,
		{ min: 0, max: 720, softMax: 360, step: 1 },
		{
			unit: 'deg',
			group: 'Motion Blur',
		},
	),
	fxParam.toggle('decontaminate', 'Decontaminate Edge Colors', true, { group: 'Decontamination' }),
	fxParam.percent('decontaminationAmount', 'Decontamination Amount', 100, { group: 'Decontamination' }),
	fxParam.toggle('extendWhereSmoothed', 'Extend Where Smoothed', true, { group: 'Decontamination' }),
	fxParam.pixels('increaseDecontaminationRadius', 'Increase Decontamination Radius', 0, 100, {
		group: 'Decontamination',
	}),
];

export const OBJECT_MATTE = defineShaderEffect({
	id: OBJECT_MATTE_EFFECT_ID,
	label: 'Object Matte',
	category: 'Keying',
	description:
		'Cuts the clip out by a Roto Brush object (computed by propagation), with After Effects-style matte refinement: feather, contrast, shift edge, reduce chatter, motion blur and edge colour decontamination. Views show the alpha, an overlay or the boundary.',
	keywords: [
		'roto',
		'roto brush',
		'rotoscope',
		'segment',
		'object',
		'cutout',
		'mask',
		'refine edge',
		'matte',
	],
	params: objectMatteParams,
	gpu: {
		mattes: [
			{ name: 'matte', param: 'object' },
			{ name: 'mattePrev', param: 'object', offset: -1 },
			{ name: 'matteNext', param: 'object', offset: 1 },
		],
		padding: (p) =>
			Math.max(0, (num(p.shiftEdge) / 100) * OBJECT_SHIFT_PX_PER_100) + 3 * (num(p.feather) / 2),
		passes: (p: EffectParams, ctx) => {
			const s = ctx.pxScale;
			const shift = (num(p.shiftEdge) / 100) * OBJECT_SHIFT_PX_PER_100 * s;
			const feather = (Math.max(0, num(p.feather)) / 2) * s;
			const decon = bool(p.decontaminate, true) && num(p.decontaminationAmount, 100) > 0;
			const mb = bool(p.useMotionBlur) && num(p.shutterAngle, 180) > 0;
			const sigma = (OBJECT_DECON_RADIUS + Math.max(0, num(p.increaseDecontaminationRadius))) * s;
			return [
				basePass('omBase', true),
				{
					output: 'omMat',
					frag: /* glsl */ `void main() { fragColor = texture(u_omBase, v_uv); }`,
				},
				...morphPasses('omMat', shift),
				...blurPasses('omMat', feather),
				...(mb ? momentPasses() : []),
				...(decon ? deconPasses(sigma) : []),
				{
					include: [GLSL_OBJECT_MATTE, GLSL_MB],
					frag: /* glsl */ `
${mb ? GLSL_OM_VELOCITY : ''}
float om_alpha(vec2 uv) { return om_contrast(texture(u_omMat, uv).r, u_contrast); }
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_matte_state < 0.5) { fragColor = src; return; }
  float a = om_alpha(v_uv);
${
	mb
		? `  if (u_shutterAngle > 0.0) {
    vec2 d = om_velocity() * (u_shutterAngle / 360.0);
    float ext = length(d * u_resolution);
    int n = fx_mbTapCount(ext, 64);
    if (n > 1) {
      float j = fx_mbJitterFor(ext, n);
      float acc = 0.0;
      for (int i = 0; i < fx_mbDyn(64); i++) {
        if (i >= n) break;
        acc += om_alpha(v_uv - d * (fx_mbTapAt(i, n, j) - 0.5));
      }
      a = acc / float(n);
    }
  }`
		: ''
}
  if (u_invert) a = 1.0 - a;
  vec4 s = fx_unpremultiply(src);
  vec3 col = s.rgb;
  float map = 0.0;
${
	decon
		? `  float base = texture(u_omBase, v_uv).r;
  bool partial = a > 0.004 && a < 0.996;
  bool region = partial && (u_extendWhereSmoothed || (base > 0.004 && base < 0.996));
  if (region && s.a > 0.0) {
    vec4 bgw = texture(u_omBg, v_uv);
    vec4 fgw = texture(u_omFg, v_uv);
    vec3 f = col;
    if (bgw.a > 1.0e-4) {
      vec3 b = bgw.rgb / bgw.a;
      f = clamp((col - (1.0 - a) * b) / max(a, 1.0e-4), 0.0, 1.0);
      if (fgw.a > 1.0e-4) f += (fgw.rgb / fgw.a - f) * clamp((0.25 - a) / 0.25, 0.0, 1.0);
    } else if (fgw.a > 1.0e-4) f = fgw.rgb / fgw.a;
    vec3 nc = col + (f - col) * clamp(u_decontaminationAmount / 100.0, 0.0, 1.0);
    map = min(1.0, max(max(abs(nc.r - col.r), abs(nc.g - col.g)), abs(nc.b - col.b)));
    col = nc;
  }`
		: ''
}
  if (u_view == 1) { fragColor = fx_inBox(v_uv) ? vec4(vec3(a), 1.0) : vec4(0.0); return; }
  if (u_view == 4) { fragColor = fx_inBox(v_uv) ? vec4(vec3(map), 1.0) : vec4(0.0); return; }
  if (u_view == 2) {
    vec3 o = mix(s.rgb, u_overlayColor.rgb, u_overlayColor.a * (1.0 - a));
    fragColor = vec4(o * s.a, s.a);
    return;
  }
  if (u_view == 3) {
    float ax = om_alpha(v_uv + vec2(u_texel.x, 0.0)) - om_alpha(v_uv - vec2(u_texel.x, 0.0));
    float ay = om_alpha(v_uv + vec2(0.0, u_texel.y)) - om_alpha(v_uv - vec2(0.0, u_texel.y));
    float g = max(length(vec2(ax, ay)) * 0.5, 1.0e-4);
    float line = 1.0 - smoothstep(0.75, 1.75, abs(a - 0.5) / g);
    vec3 o = mix(s.rgb, u_overlayColor.rgb, line);
    float oa = max(s.a, line);
    fragColor = vec4(o * oa, oa);
    return;
  }
  float out_a = s.a * a;
  fragColor = vec4(col * out_a, out_a);
}`,
				},
			];
		},
	},
});

const BLUR_METHODS = ['gaussian', 'mosaic', 'fill'] as const;

export const OBJECT_BLUR = defineShaderEffect({
	id: OBJECT_BLUR_EFFECT_ID,
	label: 'Object Blur',
	category: 'Blur & Sharpen',
	description:
		'Blurs, pixelates or fills a tracked object (a Roto Brush object or the faces found by face tracking) — or everything but it. The one-click Blur Faces workflow adds it.',
	keywords: [
		'blur faces',
		'face blur',
		'anonymize',
		'censor',
		'pixelate',
		'mosaic',
		'redact',
		'roto',
		'object',
	],
	params: [
		fxParam.object('object', 'Object'),
		fxParam.choice('region', 'Region', ['inside', 'outside'], ['Object', 'Everything Else'], 'inside'),
		fxParam.choice('method', 'Method', BLUR_METHODS, ['Gaussian Blur', 'Mosaic', 'Solid Color'], 'gaussian'),
		fxParam.pixels('blurriness', 'Blurriness', 40, 500),
		fxParam.pixels('blockSize', 'Block Size', 24, 500),
		fxParam.color('fillColor', 'Fill Color', [0, 0, 0, 1]),
		fxParam.number(
			'expand',
			'Expand',
			0,
			{ min: -200, max: 400, softMin: -50, softMax: 100, step: 0.1 },
			{
				unit: 'px',
			},
		),
		fxParam.pixels('feather', 'Feather', 6, 200),
		fxParam.percent('opacity', 'Opacity', 100),
		fxParam.choice('view', 'View', ['final', 'matte'], ['Final Result', 'Matte'], 'final'),
	],
	gpu: {
		mattes: [{ name: 'matte', param: 'object' }],
		passes: (p: EffectParams, ctx) => {
			const s = ctx.pxScale;
			const method = typeof p.method === 'string' ? p.method : 'gaussian';
			const blurSigma = (Math.max(0, num(p.blurriness, 40)) / 2) * s;
			const mosaic: ShaderPass[] =
				method === 'mosaic'
					? [
							{
								output: 'obMos',
								size: {
									width: Math.max(
										1,
										Math.min(8192, Math.ceil(ctx.width / Math.max(1, num(p.blockSize, 24)))),
									),
									height: Math.max(
										1,
										Math.min(8192, Math.ceil(ctx.height / Math.max(1, num(p.blockSize, 24)))),
									),
								},
								filter: 'nearest',
								frag: /* glsl */ `
void main() {
  // Average of each block of the layer box (4 × 4 taps).
  vec4 acc = vec4(0.0);
  vec2 cell = floor(v_uv * u_resolution);
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) {
      vec2 n = (cell + (vec2(float(i), float(j)) + 0.5) / 4.0) / u_resolution;
      acc += texture(u_source, fx_uvOfLayerNorm(n));
    }
  fragColor = acc / 16.0;
}`,
							},
						]
					: [];
			const blur: ShaderPass[] =
				method === 'gaussian'
					? [
							{
								output: 'obBlur',
								scale: blurSigma > 8 ? 0.5 : 1,
								frag: 'void main() { fragColor = texture(u_source, v_uv); }',
							},
							...blurPasses('obBlur', blurSigma > 8 ? blurSigma * 0.5 : blurSigma, blurSigma > 8 ? 0.5 : 1),
						]
					: [];
			return [
				basePass('obMat', false),
				...morphPasses('obMat', num(p.expand) * s),
				...blurPasses('obMat', (Math.max(0, num(p.feather, 6)) / 2) * s),
				...mosaic,
				...blur,
				{
					include: [GLSL_OBJECT_MATTE],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_matte_state < 0.5 || u_matte_state > 1.5) { fragColor = src; return; }
  float m = texture(u_obMat, v_uv).r;
  if (u_region == 1) m = 1.0 - m;
  m *= clamp(u_opacity / 100.0, 0.0, 1.0);
  if (u_view == 1) { fragColor = fx_inBox(v_uv) ? vec4(vec3(m), 1.0) : vec4(0.0); return; }
  vec4 fx = src;
${
	method === 'mosaic'
		? `  vec2 n = clamp(fx_layerNorm(), vec2(0.0), vec2(0.999999));
  fx = texture(u_obMos, (floor(n * u_obMos_res) + 0.5) / u_obMos_res);`
		: method === 'gaussian'
			? '  fx = texture(u_obBlur, v_uv);'
			: '  fx = fx_premultiply(u_fillColor) * (src.a > 0.0 ? 1.0 : 0.0);'
}
  fx *= fx_inBox(v_uv) ? 1.0 : 0.0;
  fragColor = mix(src, fx, m);
}`,
					...(method === 'mosaic'
						? {
								uniforms: {
									u_obMos_res: [
										Math.max(1, Math.min(8192, Math.ceil(ctx.width / Math.max(1, num(p.blockSize, 24))))),
										Math.max(1, Math.min(8192, Math.ceil(ctx.height / Math.max(1, num(p.blockSize, 24))))),
									],
								},
							}
						: {}),
				},
			];
		},
	},
});

export const OBJECT_MATTE_EFFECTS: readonly EffectSpec[] = [OBJECT_MATTE, OBJECT_BLUR];

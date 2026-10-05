// Sapphire Blur+Sharpen — edge-preserving smoothing: S_EdgeAwareBlur (separable joint-bilateral blur, optional
// Edge Source picture) and S_Beauty (skin retouch: skin-tone key in YIQ, face region, garbage mask; pore-preserving
// edge-aware smoothing, shadow softening, shine reduction, colour correction, soft focus and skin glow).
// Scales (U = half the layer width): EdgeAwareBlur σ = Blur Amount × U / 24 (as S_Blur); Beauty: Blur Amount
// σ = amount × U / 2, Pore Size σ = size × U / 4, Soft Focus / Glow Width / Post Blur σ = width × U / 4.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam } from '../params.ts';
import type { GlslChunk } from '../shader.ts';
import {
	bool,
	choiceIndex,
	GLSL_SBS_COMMON,
	num,
	px,
	SBS_EDGE_REPEAT,
	SbsPlan,
	sColor,
	sMix,
	sNum,
	sSize,
	sUnit,
	vec2,
} from './common.ts';

/** Joint-bilateral 1D blur: spatial kernel × range weight on a guide picture (premultiplied). */
export const GLSL_SBS_BILATERAL: GlslChunk = {
	name: 'sapphire-blur-sharpen/bilateral',
	deps: [GLSL_SBS_COMMON],
	source: /* glsl */ `
float sbs_rangeW(vec4 a, vec4 b, float thr, float hard, bool alpha) {
  vec3 d3 = a.rgb - b.rgb;
  float d = alpha ? length(vec4(d3, a.a - b.a)) : length(d3);
  float x = d / max(thr, 1.0e-4);
  return hard > 0.5 ? exp(-x * x * x * x) : exp(-0.5 * x * x);
}
vec4 sbs_bilateral1d(sampler2D t, sampler2D guide, vec2 uv, vec2 dir, float sigma, int filt, float thr, float hard, bool alpha) {
  vec4 c0 = sbs_tex(t, uv, SBS_EDGE_REPEAT);
  if (sigma < 0.15) return c0;
  vec2 texel = 1.0 / vec2(textureSize(t, 0));
  vec4 g0 = sbs_tex(guide, uv, SBS_EDGE_REPEAT);
  float reach = sbs_reach(sigma, filt);
  float n = min(ceil(reach), 48.0);
  float stride = max(reach / n, 1.0e-3);
  vec4 sum = c0;
  float wsum = 1.0;
  for (int i = 1; i <= 48; i++) {
    if (float(i) > n) break;
    float x = float(i) * stride;
    float k = sbs_kernel(x, sigma, filt, stride);
    vec2 o = dir * texel * x;
    vec2 ua = uv + o, ub = uv - o;
    float wa = k * sbs_rangeW(sbs_tex(guide, ua, SBS_EDGE_REPEAT), g0, thr, hard, alpha);
    float wb = k * sbs_rangeW(sbs_tex(guide, ub, SBS_EDGE_REPEAT), g0, thr, hard, alpha);
    sum += sbs_tex(t, ua, SBS_EDGE_REPEAT) * wa + sbs_tex(t, ub, SBS_EDGE_REPEAT) * wb;
    wsum += wa + wb;
  }
  return sum / wsum;
}
`,
};

/** Appends H+V joint-bilateral passes of `input` guided by `guide`; returns the output name. */
function bilateral2d(
	plan: SbsPlan,
	o: {
		input: string;
		guide: string;
		output: string;
		sigmaX: number;
		sigmaY: number;
		filter: number;
		threshold: number;
		hard: boolean;
		alpha?: boolean;
	},
): string {
	const pass = (inp: string, out: string, dir: [number, number], sigma: number) =>
		plan.pass({
			output: out,
			include: [GLSL_SBS_BILATERAL],
			format: 'rgba16f',
			uniforms: {
				u_blDir: dir,
				u_blSigma: sigma,
				u_blFilt: { int: o.filter },
				u_blThr: o.threshold,
				u_blHard: o.hard ? 1 : 0,
				u_blAlpha: !!o.alpha,
			},
			frag: `void main() { fragColor = sbs_bilateral1d(u_${inp}, u_${o.guide}, v_uv, u_blDir, u_blSigma, u_blFilt, u_blThr, u_blHard, u_blAlpha); }`,
		});
	pass(o.input, `${o.output}H`, [1, 0], o.sigmaX);
	pass(`${o.output}H`, o.output, [0, 1], o.sigmaY);
	return o.output;
}

// ---------------------------------------------------------------- S_EdgeAwareBlur

const BLUR_TYPES = ['sharpEdges', 'softEdges', 'softerEdges'] as const;
const EAB_FILTERS = ['box', 'triangle', 'gauss', 'smooth'] as const;

export const S_EDGE_AWARE_BLUR = defineShaderEffect({
	id: 'jasper.s.edge-aware-blur',
	label: 'S_EdgeAwareBlur',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Blurs regions of similar colour while keeping the edges between different colours: from a natural smoothing to a watercolour/cartoon look.',
	keywords: ['edge aware', 'bilateral', 'surface blur', 'smooth', 'cartoon', 'watercolor', 'sapphire'],
	expensive: true,
	params: [
		fxParam.media('edgeSource', 'Edge Source', ['image', 'video']),
		sSize('blurAmount', 'Blur Amount', 0.4, 4),
		fxParam.vec2('blurRel', 'Blur Rel', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		sNum('edgeThreshold', 'Edge Threshold', 0.1, { min: 0, softMax: 1, step: 0.001 }),
		sSize('edgeSmooth', 'Edge Smooth', 0, 1),
		fxParam.toggle('useAlphaEdges', 'Use Alpha Edges', false),
		fxParam.choice('blurType', 'Blur Type', BLUR_TYPES, ['Sharp Edges', 'Soft Edges', 'Softer Edges'], 'sharpEdges'),
		fxParam.choice('filter', 'Filter', EAB_FILTERS, ['Box', 'Triangle', 'Gauss', 'Smooth'], 'gauss'),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			plan.pass({
				output: 'guide0',
				include: [GLSL_SBS_COMMON],
				frag: /* glsl */ `
void main() {
  vec2 n = sbs_layerNorm(v_uv);
  fragColor = u_edgeSource_size.x > 0.0 ? texture(u_edgeSource, clamp(n, 0.0, 1.0)) : texture(u_source, v_uv);
}`,
			});
			let guide = 'guide0';
			const es = px(ctx, num(p.edgeSmooth), 1 / 24);
			if (es > 0.15)
				guide = plan.blur2d({ input: 'guide0', output: 'guide', sigmaX: es, sigmaY: es, edge: SBS_EDGE_REPEAT }).output;
			const rel = vec2(p.blurRel, [1, 1]);
			const s = px(ctx, num(p.blurAmount, 0.4), 1 / 24);
			const type = choiceIndex(p.blurType, BLUR_TYPES, 'sharpEdges');
			const fi = choiceIndex(p.filter, EAB_FILTERS, 'gauss');
			const smooth = fi === 3;
			const iters = type === 0 ? 2 : 1 + (smooth ? 1 : 0);
			const k = 1 / Math.sqrt(iters);
			const thr = Math.max(1e-4, num(p.edgeThreshold, 0.1)) * (type === 2 ? 3 : type === 1 ? 1.5 : 1);
			let tex = 'source';
			for (let i = 0; i < iters; i++)
				tex = bilateral2d(plan, {
					input: tex,
					guide,
					output: `eab${i}`,
					sigmaX: s * Math.max(0, rel[0]) * k,
					sigmaY: s * Math.max(0, rel[1]) * k,
					filter: smooth ? 2 : fi,
					threshold: thr,
					hard: type === 0,
					alpha: bool(p.useAlphaEdges),
				});
			plan.pass({ frag: `void main() { fragColor = texture(u_${tex}, v_uv); }` });
			return plan.passes;
		},
	},
});

// ---------------------------------------------------------------- S_Beauty

const BEAUTY_SHOW = ['final', 'skinMask', 'withGarbageMask', 'skin', 'skinWithGarbageMask'] as const;

export const S_BEAUTY = defineShaderEffect({
	id: 'jasper.s.beauty',
	label: 'S_Beauty',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Skin retouching: smooths skin (keeping pores and edges), softens shadows, reduces shine, corrects colour and adds a soft glow — only where a skin-tone key (and optional face region / garbage mask) finds skin.',
	keywords: ['beauty', 'skin', 'retouch', 'smooth skin', 'beautify', 'face', 'sapphire'],
	expensive: true,
	params: [
		fxParam.media('garbageMask', 'Mask', ['image', 'video']),
		fxParam.toggle('enableSkinDetection', 'Enable Skin Detection', true),
		sColor('skinColor', 'Skin Color', [0.556, 0.37, 0.257]),
		sNum('lumaRange', 'Luma Range', 0.4, { min: 0, softMax: 1, step: 0.001 }),
		sNum('chromaRange', 'Chroma Range', 0.15, { min: 0, softMax: 0.5, step: 0.001 }),
		sUnit('relOrange', 'Rel Orange', 1),
		sUnit('relPurple', 'Rel Purple', 0.6),
		sUnit('rangeSoftness', 'Range Softness', 0.75),
		sUnit('clipWhite', 'Clip White', 1),
		sUnit('clipBlack', 'Clip Black', 0),
		sSize('postBlur', 'Post Blur', 0, 0.2),
		fxParam.choice(
			'show',
			'Show',
			BEAUTY_SHOW,
			['Final', 'Skin Detect Mask', 'With Garbage Mask', 'Skin', 'Skin with Garbage Mask'],
			'final',
		),
		fxParam.toggle('invertMask', 'Invert Mask', false),
		fxParam.toggle('suppressBg', 'Suppress BG', false),
		fxParam.point('faceCenter', 'Face Center', [0.5, 0.5]),
		sSize('faceSoftness', 'Face Softness', 0.1, 1),
		sSize('faceRadius', 'Face Radius', 0.4, 2),
		sNum('faceRelHeight', 'Face Rel Height', 1.33, { min: 0.05, softMax: 4, step: 0.01 }),
		fxParam.angle('faceRotate', 'Face Rotate', 0),
		sSize('poreSize', 'Pore Size', 0.01, 0.1),
		sSize('blurAmount', 'Blur Amount', 0.02, 0.2),
		sNum('edgeThreshold', 'Edge Threshold', 0.1, { min: 0, softMax: 1, step: 0.001 }),
		sNum('softenShadows', 'Soften Shadows', 0.2, { min: -1, max: 1, step: 0.01 }),
		sNum('shadowThresh', 'Shadow Thresh', 0.6, { min: 0, softMax: 1, step: 0.01 }),
		sUnit('reduceShine', 'Reduce Shine', 0),
		sNum('shineSaturation', 'Shine Saturation', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('shineThresh', 'Shine Thresh', 0.9, { min: 0, softMax: 1, step: 0.01 }),
		sNum('hueShift', 'Hue Shift', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('saturation', 'Saturation', 1.1, { min: -2, max: 8, step: 0.01 }),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		sColor('tint', 'Tint', [1, 1, 1]),
		sSize('softFocus', 'Soft Focus', 0, 0.5),
		sNum('glowBrightness', 'Glow Brightness', 0.1, { min: 0, softMax: 2, step: 0.01 }),
		sColor('glowColor', 'Glow Color', [1, 1, 1]),
		sNum('glowThreshold', 'Glow Threshold', 0.2, { min: 0, softMax: 1, step: 0.01 }),
		sSize('glowWidth', 'Glow Width', 0.1, 1),
		sMix(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({
			// Face ellipse radius in layer-normalised units (Sapphire units are half the layer width).
			u_faceR: [num(p.faceRadius, 0.4) * 0.5, num(p.faceRadius, 0.4) * 0.5 * num(p.faceRelHeight, 1.33) * (ctx.width / Math.max(1, ctx.height))],
			u_faceSoft: Math.max(1e-3, num(p.faceSoftness, 0.1) * 0.5),
		}),
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			plan.pass({
				output: 'mask',
				include: [GLSL_SBS_COMMON],
				frag: /* glsl */ `
float skinKey(vec3 c) {
  if (!u_enableSkinDetection) return 1.0;
  vec3 y = sbs_rgb2yiq(c), k = sbs_rgb2yiq(u_skinColor.rgb);
  float dl = abs(y.x - k.x) / max(u_lumaRange, 1.0e-4);
  vec2 cr = max(u_chromaRange * vec2(u_relOrange, u_relPurple), vec2(1.0e-4));
  float dc = length((y.yz - k.yz) / cr);
  float d = max(dl, dc);
  float m = clamp((1.0 - d) / max(u_rangeSoftness, 1.0e-3), 0.0, 1.0);
  return clamp((m - u_clipBlack) / max(u_clipWhite - u_clipBlack, 1.0e-3), 0.0, 1.0);
}
void main() {
  vec4 c = fx_unpremultiply(texture(u_source, v_uv));
  float skin = skinKey(c.rgb) * step(1.0e-4, c.a);
  vec2 n = sbs_layerNorm(v_uv);
  float garbage = 1.0;
  if (u_garbageMask_size.x > 0.0) garbage = fx_luma(texture(u_garbageMask, clamp(n, 0.0, 1.0)).rgb);
  if (u_invertMask) garbage = 1.0 - garbage;
  if (u_suppressBg) {
    float a = radians(u_faceRotate);
    vec2 d = n - u_faceCenter;
    d = mat2(cos(a), -sin(a), sin(a), cos(a)) * d;
    float r = length(d / u_faceR);
    garbage *= 1.0 - smoothstep(1.0 - u_faceSoft, 1.0 + u_faceSoft, r);
  }
  fragColor = vec4(skin * garbage, skin, garbage, 1.0);
}`,
			});
			let mask = 'mask';
			const pb = px(ctx, num(p.postBlur), 1 / 4);
			if (pb > 0.15) mask = plan.blur2d({ input: 'mask', output: 'maskB', sigmaX: pb, sigmaY: pb, edge: SBS_EDGE_REPEAT, maxLevel: 0 }).output;
			const pore = Math.max(0.3, px(ctx, num(p.poreSize, 0.01), 1 / 4));
			plan.blur2d({ input: 'source', output: 'base', sigmaX: pore, sigmaY: pore, edge: SBS_EDGE_REPEAT, maxLevel: 0 });
			const sb = px(ctx, num(p.blurAmount, 0.02), 1 / 2);
			bilateral2d(plan, {
				input: 'base',
				guide: 'base',
				output: 'smooth',
				sigmaX: sb,
				sigmaY: sb,
				filter: 2,
				threshold: Math.max(1e-3, num(p.edgeThreshold, 0.1)),
				hard: false,
			});
			const gw = px(ctx, num(p.glowWidth, 0.1), 1 / 4);
			const glow = gw > 0.15 && num(p.glowBrightness, 0.1) > 0;
			if (glow) plan.blur2d({ input: 'source', output: 'glow', sigmaX: gw, sigmaY: gw, edge: SBS_EDGE_REPEAT, maxLevel: 3 });
			const sf = px(ctx, num(p.softFocus), 1 / 4);
			const soft = sf > 0.15;
			if (soft) plan.blur2d({ input: 'source', output: 'soft', sigmaX: sf, sigmaY: sf, edge: SBS_EDGE_REPEAT, maxLevel: 3 });
			plan.pass({
				include: [GLSL_SBS_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 srcP = texture(u_source, v_uv);
  vec4 src = fx_unpremultiply(srcP);
  vec4 m = texture(u_${mask}, v_uv);
  float mask = m.r;
  if (u_show == 1) { fragColor = vec4(vec3(m.g), 1.0); return; }
  if (u_show == 2) { fragColor = vec4(vec3(mask), 1.0); return; }
  if (u_show == 3) { fragColor = vec4(src.rgb * m.g * src.a, src.a); return; }
  if (u_show == 4) { fragColor = vec4(src.rgb * mask * src.a, src.a); return; }
  vec3 base = fx_unpremultiply(texture(u_base, v_uv)).rgb;
  vec3 sm = fx_unpremultiply(texture(u_smooth, v_uv)).rgb;
  // Smoothed skin + the pore-sized detail of the source.
  vec3 c = sm + (src.rgb - base);
  float l = fx_luma(sm);
  // Soften Shadows: lift (or deepen) the regions darker than Shadow Thresh.
  float sh = clamp((u_shadowThresh - l) / max(u_shadowThresh, 1.0e-3), 0.0, 1.0);
  c += u_softenShadows * sh * (u_shadowThresh - l) * 0.6;
  // Reduce Shine: darken highlights above Shine Thresh, re-saturate them.
  float shine = clamp((l - u_shineThresh) / max(1.0 - u_shineThresh, 0.02), 0.0, 1.0);
  c -= u_reduceShine * shine * (l - u_shineThresh) * 1.5;
  c = fx_saturate(c, mix(1.0, u_shineSaturation, shine));
  // Colour correction.
  c = fx_hueShift(clamp(c, 0.0, 1.0), u_hueShift);
  c = fx_saturate(c, u_saturation) * u_brightness * u_tint.rgb;
${
	soft
		? `  vec3 sfc = fx_unpremultiply(texture(u_soft, v_uv)).rgb;
  c = mix(max(c, sfc), (c + sfc) * 0.5, 0.5);`
		: ''
}
${
	glow
		? `  vec3 g = fx_unpremultiply(texture(u_glow, v_uv)).rgb;
  float gl = fx_luma(g);
  vec3 light = g * clamp((gl - u_glowThreshold) / max(1.0 - u_glowThreshold, 0.02), 0.0, 1.0) * u_glowBrightness * u_glowColor.rgb;
  c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - clamp(light, 0.0, 1.0));`
		: ''
}
  c = mix(src.rgb, clamp(c, 0.0, 1.0), mask);
  vec4 result = vec4(c * src.a, src.a);
  fragColor = fx_mixOriginal(result, srcP, u_mixWithOriginal);
}`,
			});
			return plan.passes;
		},
	},
});

export const SBS_SMOOTH: readonly EffectSpec[] = [S_EDGE_AWARE_BLUR, S_BEAUTY];

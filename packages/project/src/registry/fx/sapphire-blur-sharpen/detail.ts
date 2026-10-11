// Sapphire Blur+Sharpen — detail filters: S_Sharpen (multi-band "Best" and unsharp "Fast"), S_Median (separable
// weighted median, subpixel sizes, per-channel windows), S_Deband (edge-aware diffusion), S_GrainRemove (YIQ
// smoothing outside detected edges), S_EdgeBlur (blur where a matte has edges).
// Scales (Sapphire units, U = half the layer width): Sharpen "Small Detail Size" σ = size × U / 4, "Sharpen Width"
// σ = width × U / 50; GrainRemove "Smooth" σ = smooth × U / 32, "Edges Width" σ = width × U / 16; EdgeBlur widths
// σ = width × U / 24. Median "Size" and Deband radii/blurs are layer pixels, as in Sapphire.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { fxParam } from '../params.ts';
import type { FxUniformValue } from '../shader.ts';
import { bool, GLSL_SBS_COMMON, num, px, SBS_EDGE_REPEAT, SbsPlan, sNum, sSize } from './common.ts';

const YIQ_PREP = /* glsl */ `
void main() {
  vec4 c = fx_unpremultiply(texture(u_source, v_uv));
  fragColor = vec4(sbs_rgb2yiq(c.rgb) + vec3(0.0, 0.5, 0.5), c.a);
}`;

const QUALITY = ['best', 'fast'] as const;

export const S_SHARPEN = defineShaderEffect({
	id: 'jasper.s.sharpen',
	label: 'S_Sharpen',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Amplifies edges and details. Best: four detail bands (tiny, small, medium, large) scaled independently, strong edges left alone to avoid halos; Fast: classic unsharp mask.',
	keywords: ['sharpen', 'unsharp mask', 'detail', 'clarity', 'enhance', 'sapphire'],
	params: [
		fxParam.choice('quality', 'Quality', QUALITY, ['Best', 'Fast'], 'best'),
		sNum('sharpenAmp', 'Sharpen Amp', 1, { softMin: -2, softMax: 4, step: 0.01 }),
		sNum('edgeThreshold', 'Edge Threshold', 0.15, { min: 0, softMax: 1, step: 0.001 }),
		sSize('smallDetailSize', 'Small Detail Size', 0.01, 0.1),
		sNum('scaleTinyDetails', 'Scale Tiny Details', 3, { min: 0, softMax: 8, step: 0.01 }),
		sNum('scaleSmallDetails', 'Scale Small Details', 1.5, { min: 0, softMax: 8, step: 0.01 }),
		sNum('scaleMediumDetails', 'Scale Medium Details', 1, { min: 0, softMax: 8, step: 0.01 }),
		sNum('scaleLargeDetails', 'Scale Large Details', 2, { min: 0, softMax: 8, step: 0.01 }),
		sSize('sharpenWidth', 'Sharpen Width', 0.112, 1),
		sNum('sharpenLuma', 'Sharpen Luma', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('sharpenChroma', 'Sharpen Chroma', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('sharpenRed', 'Sharpen Red', 1, { softMin: -2, softMax: 4, step: 0.01 }),
		sNum('sharpenGreen', 'Sharpen Green', 1, { softMin: -2, softMax: 4, step: 0.01 }),
		sNum('sharpenBlue', 'Sharpen Blue', 1, { softMin: -2, softMax: 4, step: 0.01 }),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			plan.pass({ output: 'yiq', include: [GLSL_SBS_COMMON], format: 'rgba16f', frag: YIQ_PREP });
			const blur = (out: string, s: number) =>
				plan.blur2d({ input: 'yiq', output: out, sigmaX: s, sigmaY: s, edge: SBS_EDGE_REPEAT });
			const tail = /* glsl */ `
vec4 sharpTail(vec3 srcYiq, vec3 dYiq, float a) {
  dYiq *= vec3(u_sharpenLuma, u_sharpenChroma, u_sharpenChroma);
  vec3 s = sbs_yiq2rgb(srcYiq - vec3(0.0, 0.5, 0.5));
  vec3 d = sbs_yiq2rgb(dYiq) * vec3(u_sharpenRed, u_sharpenGreen, u_sharpenBlue);
  return vec4(clamp(s + d, 0.0, 1.0) * a, a);
}`;
			if (p.quality === 'fast') {
				blur('g1', px(ctx, num(p.sharpenWidth, 0.112), 1 / 50));
				plan.pass({
					include: [GLSL_SBS_COMMON],
					frag: /* glsl */ `${tail}
void main() {
  vec4 y = texture(u_yiq, v_uv);
  vec4 g = texture(u_g1, v_uv);
  fragColor = sharpTail(y.rgb, (y.rgb - g.rgb) * u_sharpenAmp, y.a);
}`,
				});
				return plan.passes;
			}
			const s = px(ctx, num(p.smallDetailSize, 0.01), 1 / 4);
			blur('g1', s * 0.5);
			blur('g2', s);
			blur('g3', s * 2);
			blur('g4', s * 4);
			plan.pass({
				include: [GLSL_SBS_COMMON],
				frag: /* glsl */ `${tail}
void main() {
  vec4 y = texture(u_yiq, v_uv);
  vec3 g1 = texture(u_g1, v_uv).rgb, g2 = texture(u_g2, v_uv).rgb, g3 = texture(u_g3, v_uv).rgb, g4 = texture(u_g4, v_uv).rgb;
  // Edges stronger than the threshold (local contrast at the large scale) are not sharpened (no halos).
  float e = abs(y.r - g4.r) + abs(g1.r - g4.r);
  float t = max(u_edgeThreshold, 1.0e-4);
  float gate = 1.0 - smoothstep(t * 0.5, t * 1.5, e);
  vec3 d = (u_scaleTinyDetails - 1.0) * (y.rgb - g1) + (u_scaleSmallDetails - 1.0) * (g1 - g2)
         + (u_scaleMediumDetails - 1.0) * (g2 - g3) + (u_scaleLargeDetails - 1.0) * (g3 - g4);
  fragColor = sharpTail(y.rgb, d * gate * u_sharpenAmp, y.a);
}`,
			});
			return plan.passes;
		},
	},
});

const MEDIAN_MODES = ['median', 'medianChannels'] as const;
const MEDIAN_TAPS = 81;

const MEDIAN_GLSL = /* glsl */ `
vec4 mV[${MEDIAN_TAPS}];
vec4 mW[${MEDIAN_TAPS}];
// Weighted median per channel by bisection on the value (10 steps ≈ 1/1024).
vec4 sbs_wmedian(int n, vec4 wtot) {
  vec4 lo = vec4(0.0), hi = vec4(1.0);
  for (int it = 0; it < 10; it++) {
    vec4 mid = 0.5 * (lo + hi);
    vec4 c = vec4(0.0);
    for (int i = 0; i < ${MEDIAN_TAPS}; i++) {
      if (i >= n) break;
      c += mW[i] * step(mV[i], mid);
    }
    vec4 ge = step(0.5 * wtot, c);
    hi = mix(hi, mid, ge);
    lo = mix(mid, lo, ge);
  }
  return 0.5 * (lo + hi);
}
vec4 sbs_median1d(sampler2D t, vec2 dir, vec4 r) {
  vec2 texel = 1.0 / vec2(textureSize(t, 0));
  float rmax = max(max(r.x, r.y), max(r.z, r.w));
  int half_ = int(min(ceil(rmax - 0.01), 40.0));
  int n = 0;
  vec4 wtot = vec4(0.0);
  for (int i = -40; i <= 40; i++) {
    if (i < -half_ || i > half_) continue;
    float d = abs(float(i));
    vec4 w = u_mSub ? clamp(r + 0.5 - d, 0.0, 1.0) : step(vec4(d), floor(r + 0.5));
    if (i == 0) w = vec4(1.0);
    mV[n] = clamp(sbs_tex(t, v_uv + dir * texel * float(i), ${SBS_EDGE_REPEAT}), 0.0, 1.0);
    mW[n] = w;
    wtot += w;
    n++;
  }
  return sbs_wmedian(n, wtot);
}`;

export const S_MEDIAN = defineShaderEffect({
	id: 'jasper.s.median',
	label: 'S_Median',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Median filter: removes isolated spots, dust and impulse noise while keeping edges; optionally a different window per channel.',
	keywords: ['median', 'despeckle', 'noise', 'dust', 'clean', 'sapphire'],
	expensive: true,
	params: [
		fxParam.choice('effect', 'Effect', MEDIAN_MODES, ['Median', 'MedianChannels'], 'median'),
		sNum('size', 'Size', 1, { min: 0.1, max: 40, step: 0.1 }),
		fxParam.toggle('subpixel', 'Subpixel', false),
		sNum('sizeRelX', 'Size Rel X', 1, { min: 0.1, max: 5, step: 0.01 }),
		sNum('sizeRelY', 'Size Rel Y', 1, { min: 0.1, max: 5, step: 0.01 }),
		...(['Red', 'Green', 'Blue', 'Alpha'] as const).flatMap((c) => [
			sNum(`${c.toLowerCase()}RelSizeX`, `${c} Rel Size X`, 1, { min: 0, max: 2, step: 0.01 }),
			sNum(`${c.toLowerCase()}RelSizeY`, `${c} Rel Size Y`, 1, { min: 0, max: 2, step: 0.01 }),
		]),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const size = Math.max(0.1, Math.min(40, num(p.size, 1))) * ctx.pxScale;
			const perCh = p.effect === 'medianChannels';
			const rel = (c: string, axis: 'X' | 'Y') => (perCh ? num(p[`${c}RelSize${axis}`], 1) : 1);
			const chans = ['red', 'green', 'blue', 'alpha'];
			const rx = chans.map((c) => Math.min(40, size * num(p.sizeRelX, 1) * rel(c, 'X'))) as [
				number,
				number,
				number,
				number,
			];
			const ry = chans.map((c) => Math.min(40, size * num(p.sizeRelY, 1) * rel(c, 'Y'))) as [
				number,
				number,
				number,
				number,
			];
			const u: Record<string, FxUniformValue> = { u_mSub: bool(p.subpixel) };
			return [
				{
					output: 'medH',
					include: [GLSL_SBS_COMMON],
					format: 'rgba16f',
					uniforms: { ...u, u_mR: rx },
					frag: `${MEDIAN_GLSL}\nvoid main() { fragColor = sbs_median1d(u_source, vec2(1.0, 0.0), u_mR); }`,
				},
				{
					include: [GLSL_SBS_COMMON],
					uniforms: { ...u, u_mR: ry },
					frag: `${MEDIAN_GLSL}\nvoid main() { vec4 m = sbs_median1d(u_medH, vec2(0.0, 1.0), u_mR); m.rgb = min(m.rgb, vec3(m.a)); fragColor = m; }`,
				},
			];
		},
	},
});

const DEBAND_SHOW = ['result', 'edges'] as const;

export const S_DEBAND = defineShaderEffect({
	id: 'jasper.s.deband',
	label: 'S_Deband',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Removes banding (posterised gradients) by diffusing pixels across the bands while keeping real edges intact. Use Show: Edges to set the Edge Threshold.',
	keywords: ['deband', 'banding', 'posterize', 'gradient', 'contour', '8-bit', 'sapphire'],
	params: [
		sNum('edgeThreshold', 'Edge Threshold', 2, { min: 0, max: 255, step: 0.1 }),
		sNum('growEdges', 'Grow Edges', 0, { min: 0, softMax: 10, step: 0.1 }),
		fxParam.choice('show', 'Show', DEBAND_SHOW, ['Result', 'Edges'], 'result'),
		sNum('diffuseThreshold', 'Diffuse Threshold', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('diffuseRadius', 'Diffuse Radius', 12, { min: 0, softMax: 64, step: 0.1 }),
		sNum('preBlur', 'Pre Blur', 0, { min: 0, softMax: 4, step: 0.01 }),
		sNum('postBlur', 'Post Blur', 0.5, { min: 0, softMax: 4, step: 0.01 }),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			let src = 'source';
			const pre = num(p.preBlur) * ctx.pxScale;
			if (pre > 0)
				src = plan.blur2d({
					input: 'source',
					output: 'pre',
					sigmaX: pre,
					sigmaY: pre,
					edge: SBS_EDGE_REPEAT,
					format: 'rgba16f',
					maxLevel: 0,
				}).output;
			// Edges: a neighbour differs by more than the threshold (8-bit steps).
			plan.pass({
				output: 'edges',
				include: [GLSL_SBS_COMMON],
				frag: /* glsl */ `
float d(vec4 a, vec4 b) { vec4 x = abs(a - b); return max(max(x.r, x.g), max(x.b, x.a)) * 255.0; }
void main() {
  vec2 tx = 1.0 / vec2(textureSize(u_${src}, 0));
  vec4 c = sbs_tex(u_${src}, v_uv, ${SBS_EDGE_REPEAT});
  float m = max(max(d(c, sbs_tex(u_${src}, v_uv + vec2(tx.x, 0.0), ${SBS_EDGE_REPEAT})), d(c, sbs_tex(u_${src}, v_uv - vec2(tx.x, 0.0), ${SBS_EDGE_REPEAT}))),
                max(d(c, sbs_tex(u_${src}, v_uv + vec2(0.0, tx.y), ${SBS_EDGE_REPEAT})), d(c, sbs_tex(u_${src}, v_uv - vec2(0.0, tx.y), ${SBS_EDGE_REPEAT}))));
  float e = m > u_edgeThreshold + 0.5 ? 1.0 : 0.0;
  fragColor = vec4(e, e, e, 1.0);
}`,
			});
			let edges = 'edges';
			const grow = num(p.growEdges) * ctx.pxScale;
			if (grow > 0) {
				for (const [i, dir] of [
					[0, '1.0, 0.0'],
					[1, '0.0, 1.0'],
				] as const) {
					const out = `grow${i}`;
					plan.pass({
						output: out,
						include: [GLSL_SBS_COMMON],
						uniforms: { u_grow: grow },
						frag: /* glsl */ `
void main() {
  vec2 tx = 1.0 / vec2(textureSize(u_${edges}, 0));
  float m = 0.0;
  float n = min(ceil(u_grow), 32.0);
  for (int i = -32; i <= 32; i++) {
    if (abs(float(i)) > n) continue;
    m = max(m, texture(u_${edges}, v_uv + vec2(${dir}) * tx * float(i)).r);
  }
  fragColor = vec4(m, m, m, 1.0);
}`,
					});
					edges = out;
				}
			}
			const radius = num(p.diffuseRadius, 12) * ctx.pxScale;
			plan.pass({
				output: 'diffuse',
				include: [GLSL_SBS_COMMON, GLSL_HASH],
				format: 'rgba16f',
				uniforms: { u_dRadius: radius },
				frag: /* glsl */ `
void main() {
  vec4 c = texture(u_${src}, v_uv);
  if (texture(u_${edges}, v_uv).r > 0.5 || u_dRadius < 0.5) { fragColor = c; return; }
  vec2 tx = 1.0 / vec2(textureSize(u_${src}, 0));
  float thr = max(u_diffuseThreshold * max(u_edgeThreshold, 0.5), 0.01) / 255.0 * 1.5;
  float rot = fx_hash2(ivec2(floor(v_uv * u_resolution)), 0.37) * 6.2831853;
  vec4 sum = c;
  float n = 1.0;
  for (int i = 0; i < 32; i++) {
    float r = sqrt((float(i) + 0.5) / 32.0) * u_dRadius;
    float a = float(i) * 2.39996323 + rot;
    vec2 uv = v_uv + vec2(cos(a), sin(a)) * r * tx;
    vec4 s = sbs_tex(u_${src}, uv, ${SBS_EDGE_REPEAT});
    vec4 dd = abs(s - c);
    if (max(max(dd.r, dd.g), max(dd.b, dd.a)) <= thr && texture(u_${edges}, uv).r < 0.5) { sum += s; n += 1.0; }
  }
  fragColor = sum / n;
}`,
			});
			const post = num(p.postBlur, 0.5) * ctx.pxScale;
			const blurred =
				post > 0
					? plan.blur2d({
							input: 'diffuse',
							output: 'post',
							sigmaX: post,
							sigmaY: post,
							edge: SBS_EDGE_REPEAT,
							format: 'rgba16f',
							maxLevel: 0,
						}).output
					: 'diffuse';
			plan.pass({
				include: [GLSL_SBS_COMMON],
				frag: /* glsl */ `
void main() {
  float e = texture(u_${edges}, v_uv).r;
  if (u_show == 1) { fragColor = vec4(vec3(e), 1.0); return; }
  vec4 src = texture(u_source, v_uv);
  vec4 r = texture(u_${blurred}, v_uv);
  fragColor = mix(r, src, e);
}`,
			});
			return plan.passes;
		},
	},
});

export const S_GRAIN_REMOVE = defineShaderEffect({
	id: 'jasper.s.grain-remove',
	label: 'S_GrainRemove',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Smooths grain and noise in flat areas (luma and chroma separately) while keeping detected edges sharp. Use Show: Edges to tune the edge detection.',
	keywords: ['grain', 'denoise', 'noise reduction', 'smooth', 'degrain', 'sapphire'],
	params: [
		sSize('smooth', 'Smooth', 0.088, 1),
		sNum('smoothLuma', 'Smooth Luma', 0.5, { min: 0, softMax: 4, step: 0.01 }),
		sNum('smoothChroma', 'Smooth Chroma', 1, { min: 0, softMax: 4, step: 0.01 }),
		sSize('edgesWidth', 'Edges Width', 0.0224, 0.2),
		sNum('edgesScale', 'Edges Scale', 0.25, { min: 0, softMax: 2, step: 0.01 }),
		sNum('edgesThreshold', 'Edges Threshold', 0.3, { min: 0, softMax: 1, step: 0.01 }),
		fxParam.choice('show', 'Show', DEBAND_SHOW, ['Result', 'Edges'], 'result'),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			plan.pass({ output: 'yiq', include: [GLSL_SBS_COMMON], format: 'rgba16f', frag: YIQ_PREP });
			const s = px(ctx, num(p.smooth, 0.088), 1 / 32);
			const sl = s * Math.max(0, num(p.smoothLuma, 0.5));
			const sc = s * Math.max(0, num(p.smoothChroma, 1));
			const m = Math.max(sl, sc, 1e-6);
			plan.blur2d({
				input: 'yiq',
				output: 'smoothed',
				sigmaX: m,
				sigmaY: m,
				edge: SBS_EDGE_REPEAT,
				channels: [sl / m, sc / m, sc / m, 0],
				maxLevel: 0,
			});
			const se = Math.max(0.5, px(ctx, num(p.edgesWidth, 0.0224), 1 / 16));
			plan.blur2d({
				input: 'yiq',
				output: 'edgeBlur',
				sigmaX: se,
				sigmaY: se,
				edge: SBS_EDGE_REPEAT,
				maxLevel: 0,
			});
			plan.pass({
				include: [GLSL_SBS_COMMON],
				uniforms: { u_edgeStep: se },
				frag: /* glsl */ `
void main() {
  vec2 tx = u_edgeStep / vec2(textureSize(u_edgeBlur, 0));
  float gx = texture(u_edgeBlur, v_uv + vec2(tx.x, 0.0)).r - texture(u_edgeBlur, v_uv - vec2(tx.x, 0.0)).r;
  float gy = texture(u_edgeBlur, v_uv + vec2(0.0, tx.y)).r - texture(u_edgeBlur, v_uv - vec2(0.0, tx.y)).r;
  float e = clamp(length(vec2(gx, gy)) * u_edgesScale * 40.0 - u_edgesThreshold, 0.0, 1.0);
  if (u_show == 1) { fragColor = vec4(vec3(e), 1.0); return; }
  vec4 src = texture(u_source, v_uv);
  vec4 y = texture(u_yiq, v_uv);
  vec3 sm = texture(u_smoothed, v_uv).rgb;
  vec3 yiq = mix(sm, y.rgb, e) - vec3(0.0, 0.5, 0.5);
  fragColor = vec4(clamp(sbs_yiq2rgb(yiq), 0.0, 1.0) * src.a, src.a);
}`,
			});
			return plan.passes;
		},
	},
});

const MATTE_USE = ['luma', 'alpha'] as const;

export const S_EDGE_BLUR = defineShaderEffect({
	id: 'jasper.s.edge-blur',
	label: 'S_EdgeBlur',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Finds the edges of a matte (or of the clip itself) and blurs the clip only along them — softens hard key edges and composites.',
	keywords: ['edge', 'blur', 'matte', 'key', 'soften edges', 'composite', 'sapphire'],
	params: [
		fxParam.media('matte', 'Matte', ['image', 'video']),
		sSize('blurWidth', 'Blur Width', 0.112, 1),
		sSize('edgeWidth', 'Edge Width', 0.112, 1),
		sNum('edgeStrength', 'Edge Strength', 0.5, { min: 0, softMax: 4, step: 0.01 }),
		sNum('edgeThreshold', 'Edge Threshold', 0, { min: 0, softMax: 1, step: 0.01 }),
		fxParam.choice('show', 'Show', DEBAND_SHOW, ['Result', 'Edges'], 'result'),
		fxParam.choice('matteUse', 'Matte Use', MATTE_USE, ['Luma', 'Alpha'], 'luma'),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			plan.pass({
				output: 'm',
				include: [GLSL_SBS_COMMON],
				format: 'rgba16f',
				frag: /* glsl */ `
void main() {
  vec4 c = u_matte_size.x > 0.0 ? (sbs_outside(sbs_layerNorm(v_uv)) ? vec4(0.0) : texture(u_matte, sbs_layerNorm(v_uv))) : texture(u_source, v_uv);
  float m = u_matteUse == 1 ? c.a : fx_luma(fx_unpremultiply(c).rgb) * c.a;
  fragColor = vec4(m, m, m, 1.0);
}`,
			});
			const se = Math.max(0.5, px(ctx, num(p.edgeWidth, 0.112), 1 / 24));
			plan.blur2d({ input: 'm', output: 'mb', sigmaX: se, sigmaY: se, edge: SBS_EDGE_REPEAT });
			const sb = px(ctx, num(p.blurWidth, 0.112), 1 / 24);
			plan.blur2d({ input: 'source', output: 'blur', sigmaX: sb, sigmaY: sb, edge: SBS_EDGE_REPEAT });
			plan.pass({
				include: [GLSL_SBS_COMMON],
				uniforms: { u_edgeSigma: se },
				frag: /* glsl */ `
void main() {
  vec2 tx = 1.0 / u_canvasSize;
  float gx = texture(u_mb, v_uv + vec2(tx.x, 0.0)).r - texture(u_mb, v_uv - vec2(tx.x, 0.0)).r;
  float gy = texture(u_mb, v_uv + vec2(0.0, tx.y)).r - texture(u_mb, v_uv - vec2(0.0, tx.y)).r;
  // A blurred unit step peaks at 1 / (sqrt(2 pi) sigma) per px: normalise so a hard matte edge gives ~1.
  float g = length(vec2(gx, gy)) * 0.5 * u_edgeSigma * 2.5066;
  float e = clamp(g * u_edgeStrength * 2.0 - u_edgeThreshold, 0.0, 1.0);
  if (u_show == 1) { fragColor = vec4(vec3(e), 1.0); return; }
  fragColor = mix(texture(u_source, v_uv), texture(u_blur, v_uv), e);
}`,
			});
			return plan.passes;
		},
	},
});

export const SBS_DETAIL: readonly EffectSpec[] = [S_SHARPEN, S_MEDIAN, S_DEBAND, S_GRAIN_REMOVE, S_EDGE_BLUR];

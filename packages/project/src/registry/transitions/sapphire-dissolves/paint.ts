// Sapphire-style S_DissolveAutoPaint: a paint-brushed version of the outgoing clip fades in, its strokes grow and the
// painting simplifies to a few colours at the peak, then the painting of the incoming clip refines and fades out to
// the clip. Parameters follow Boris FX's public Sapphire documentation; clean-room implementation.
//
// Compact version of the (not yet merged) auto-paint family: brush strokes are gathered on a jittered grid (5×5
// cells around each pixel), each an elliptical dab oriented by the smoothed structure tensor of the picture (Van Gogh:
// along the edges; Hairy Paint: across them; Pointalize: round), coloured from the (Smooth Colors) blurred picture at
// its centre, with bristle shading; then a sharpening pass. Approximation: Sapphire documents Max Brush Size as the
// size "at the beginning and end" but describes the painting simplifying towards the middle; here the brush grows
// from Min Brush Size (ends) to Max Brush Size (peak), which matches the described look.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import {
	blurPasses,
	blurPx,
	clamp,
	defineDissolve,
	dissolveTiming,
	GLSL_SD,
	GLSL_SD_NOISE,
	intSlider,
	num,
	seed,
	slider,
} from './common.ts';

export const PAINT_STYLES = ['vanGogh', 'hairyPaint', 'pointalize'] as const;

/** Paint amount (0..1) at timing t: fades in over Paint Fade at the start, out over Paint Fade at the end. */
export function paintAmount(p: EffectParams, t: number): number {
	const f = clamp(num(p.paintFade, 0.25), 0.001, 0.5);
	const s = (x: number) => {
		const c = clamp(x, 0, 1);
		return c * c * (3 - 2 * c);
	};
	return Math.min(s(t / f), s((1 - t) / f));
}

/** Brush size (frame px) at envelope env: Min Brush Size at the ends → Max Brush Size at the peak (1.0 = a quarter of the frame width; eased so detail lasts). */
export function brushPx(p: EffectParams, env: number, width: number): number {
	const lo = clamp(num(p.minBrushSize, 0.04), 0.0025, 1);
	const hi = clamp(num(p.maxBrushSize, 0.4), 0.0025, 1);
	return Math.max(2, (lo + (hi - lo) * env * env) * 0.25 * width);
}

export const S_DISSOLVE_AUTO_PAINT: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-auto-paint',
	expensive: true,
	label: 'S_DissolveAutoPaint',
	description:
		'Dissolves through a painting: a brush-stroke version of the outgoing clip fades in and simplifies to a few big strokes at the peak, then the painting of the incoming clip refines and fades into the clip (Van Gogh, Hairy Paint or Pointalize strokes).',
	keywords: ['auto paint', 'paint', 'brush strokes', 'painterly', 'van gogh', 'artistic', 'dissolve'],
	timing: { speed: 3 },
	params: [
		slider('paintFade', 'Paint Fade', 0.25, { min: 0, max: 1 }),
		fxParam.choice('style', 'Style', PAINT_STYLES, ['Van Gogh', 'Hairy Paint', 'Pointalize'], 'vanGogh'),
		slider('minBrushSize', 'Min Brush Size', 0.04, { min: 0.0025, max: 1, step: 0.001 }),
		slider('maxBrushSize', 'Max Brush Size', 0.4, { min: 0.0025, max: 1, step: 0.001 }),
		slider('strokeLength', 'Stroke Length', 2, { softMin: -4, softMax: 4 }),
		slider('strokeAlign', 'Stroke Align', 0.2, { min: 0, softMax: 2 }),
		slider('smoothColors', 'Smooth Colors', 0, { min: 0, softMax: 2 }),
		seed(),
		intSlider('jitterFrames', 'Jitter Frames', 0, 0, 100),
		slider('sharpen', 'Sharpen', 1, { min: 0, softMax: 4 }),
		slider('sharpenWidth', 'Sharpen Width', 0.2, { min: 0, softMax: 1 }),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const d = dissolveTiming(p, ctx.progress);
			const brush = brushPx(p, d.env, ctx.width);
			const jf = Math.max(0, Math.round(num(p.jitterFrames, 0)));
			return {
				u_paint: paintAmount(p, d.t),
				u_brushPx: brush,
				u_strokeSeed: jf > 0 ? (Math.floor(ctx.frame / jf) * 0.1031) % 1 : 0,
				u_smoothPx: blurPx(p.smoothColors, ctx.width) + brush * 0.08,
				u_alignPx: blurPx(p.strokeAlign, ctx.width) * 2 + brush * 0.25,
			};
		},
		passes: (): ShaderPass[] => [
			{
				// The dissolve at ¼ resolution (box-averaged), the colours the strokes pick up.
				output: 'paintSrc',
				scale: 0.25,
				frag: /* glsl */ `
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    vec2 o = (vec2(float(i % 4), float(i / 4)) + 0.5) / 4.0 - 0.5;
    vec2 uv = v_uv + o / u_resolution;
    acc += mix(tr_from(uv), tr_to(uv), u_sdMix);
  }
  fragColor = acc / 16.0;
}`,
			},
			...blurPasses({ input: 'paintSrc', output: 'srcBlur', scale: 0.25, sigma: 'vec2(u_smoothPx)' }),
			{
				// Structure tensor of the luma: (gx² − gy², 2·gx·gy, gx² + gy²) — direction in doubled-angle form.
				output: 'grad',
				scale: 0.25,
				format: 'rgba16f',
				include: [GLSL_SD],
				frag: /* glsl */ `
float L(vec2 uv) { vec4 c = texture(u_srcBlur, uv); return fx_luma(c.rgb); }
void main() {
  vec2 h = 1.5 / u_resolution;
  float gx = L(v_uv + vec2(h.x, 0.0)) - L(v_uv - vec2(h.x, 0.0));
  float gy = L(v_uv + vec2(0.0, h.y)) - L(v_uv - vec2(0.0, h.y));
  fragColor = vec4(gx * gx - gy * gy, 2.0 * gx * gy, gx * gx + gy * gy, 1.0);
}`,
			},
			...blurPasses({
				input: 'grad',
				output: 'gradB',
				scale: 0.25,
				sigma: 'vec2(u_alignPx)',
				format: 'rgba16f',
			}),
			{
				// The strokes, gathered from the 5×5 cells around each pixel (topmost stroke by a random depth).
				output: 'painted',
				include: [GLSL_SD, GLSL_SD_NOISE],
				frag: /* glsl */ `
void main() {
  vec2 px = tr_px();
  float cellPx = max(u_brushPx * 0.45, 1.5);
  ivec2 c0 = ivec2(floor(px / cellPx));
  uint s = sd_seedU(fract(u_seed + u_strokeSeed));
  float width = u_brushPx * 0.3;
  float len = u_style == 2 ? width : width * max(1.0, abs(u_strokeLength) * 0.9);
  // Hairy Paint (or a negative Stroke Length) strokes cross the edges; Van Gogh strokes follow them.
  bool across = (u_style == 1) != (u_strokeLength < 0.0);
  vec4 best = texture(u_srcBlur, v_uv);
  float bestZ = -1.0;
  float shade = 1.0;
  for (int k = 0; k < 25; k++) {
    ivec2 c = c0 + ivec2(k % 5 - 2, k / 5 - 2);
    vec2 centre = (vec2(c) + vec2(sd_h2(c, s), sd_h2(c + ivec2(9173, 0), s))) * cellPx;
    vec2 cuv = centre / u_compSize;
    vec4 st = texture(u_gradB, cuv);
    // Direction of the gradient (half the doubled angle); strokes run perpendicular to it (along the edges).
    float ga = 0.5 * atan(st.y, st.x);
    float jit = (sd_h2(c + ivec2(0, 7741), s) - 0.5) * (st.z > 1e-5 ? 0.35 : 3.14159);
    float a = (across ? ga : ga + 1.5707963) + jit;
    vec2 dir = vec2(cos(a), sin(a));
    vec2 d = px - centre;
    float u = dot(d, dir), v = dot(d, vec2(-dir.y, dir.x));
    float r = (u * u) / (len * len) + (v * v) / (width * width);
    float edge = 1.0 + 0.25 * sd_vnoise(vec2(u, v) / width * 2.0, fract(float(k) * 0.37));
    if (r > edge) continue;
    float z = sd_h2(c + ivec2(31, 57), s);
    if (z <= bestZ) continue;
    bestZ = z;
    best = texture(u_srcBlur, cuv);
    // Bristles along the stroke and a darker rim.
    float bristle = sd_vnoise(vec2(u / len * 2.0, v / width * 6.0), fract(z + 0.5));
    shade = 1.0 + 0.07 * bristle - 0.12 * smoothstep(0.55, 1.0, r / edge);
  }
  fragColor = vec4(clamp(best.rgb * shade, 0.0, best.a), best.a);
}`,
			},
			{
				include: [GLSL_SD],
				frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec4 pt = texture(u_painted, v_uv);
  if (u_sharpen > 0.0) {
    vec2 o = max(u_sharpenWidth * u_brushPx * 0.3, 1.0) / u_compSize;
    vec4 bl = 0.25 * (texture(u_painted, v_uv + vec2(o.x, 0.0)) + texture(u_painted, v_uv - vec2(o.x, 0.0))
                    + texture(u_painted, v_uv + vec2(0.0, o.y)) + texture(u_painted, v_uv - vec2(0.0, o.y)));
    pt = clamp(pt + (pt - bl) * u_sharpen * 0.5, 0.0, 1.0);
    pt.rgb = min(pt.rgb, vec3(pt.a));
  }
  fragColor = mix(mix(base, pt, u_paint), sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

export const PAINT_DISSOLVES = [S_DISSOLVE_AUTO_PAINT] as const;

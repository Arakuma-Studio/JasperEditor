// `reflection` (§5.1): a mirrored fade below the title, as on a glossy floor, ported from Pachislop's floorReflection
// (effects/a/shadow.ts). It mirrors the layers below it in the stack, so it goes on top of them, and it draws behind them.
// The mirror line sits under the outermost rim wherever the layer is (`outermost`), and it blurs and fades with distance.
import { fmtDistance, fmtNumber, lp, type TitleLayerInit } from '../contract.ts';
import { GLSL_TL_LIGHT } from '../light.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const SIGMAS = 3;

const picture = (p: Record<string, unknown>) =>
	p.from === 'source'
		? /* glsl */ `
vec4 tl_picture(vec2 uv) { vec4 c = tl_sourceLinear(uv); return vec4(c.rgb * c.a, c.a); }`
		: /* glsl */ `
vec4 tl_picture(vec2 uv) { return texture(u_tlComp, uv); }`;

export const REFLECTION_LAYER: TitleLayerInit = {
	type: 'reflection',
	label: 'Reflection',
	description: 'A mirrored copy below the title, as on a glossy floor, fading and blurring with distance.',
	finish: false,
	outermost: true,
	params: [
		lp.choice('from', 'From', ['stack', 'source'], ['Layers Below', 'Clip Picture'], 'stack'),
		lp.distance('gap', 'Gap', 4, { min: -100, softMin: -20, softMax: 40 }),
		lp.distance('fade', 'Fade', 100, { softMax: 300 }),
		lp.distance('blur', 'Blur', 10, { softMax: 60 }),
		lp.number('falloff', 'Falloff', 1.4, { min: 0.3, max: 5, step: 0.05 }),
		lp.number('scale', 'Vertical Scale', 1, { min: 0.2, max: 2, step: 0.01 }),
		lp.percent('opacity', 'Opacity', 45),
	],
	shader(p) {
		const blurred = num(p.blur) > 0;
		return {
			glsl: /* glsl */ `${picture(p)}
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  float base = tl_bounds().w + s.base;
  float d = s.px.y - (base + tl_px(u_gap));
  if (d <= 0.0) return vec4(0.0);
  float t = clamp(d / max(tl_px(u_fade), 1.0), 0.0, 1.0);
  vec2 q = vec2(s.uv.x, (base - d / max(u_scale, 0.05)) / u_canvasSize.y);
  if (q.y < 0.0) return vec4(0.0);
  vec4 r = ${blurred ? 'mix(tl_picture(q), texture(u_tlBlur, q), smoothstep(0.0, 0.85, t))' : 'tl_picture(q)'};
  r *= pow(1.0 - t, u_falloff) * (u_opacity * 0.01) * clamp(d + 0.5, 0.0, 1.0);
  return tl_result(under, under + r * (1.0 - under.a));
}`,
			include: [GLSL_TL_LIGHT],
		};
	},
	blur(p) {
		const sigma = num(p.blur) / SIGMAS;
		if (sigma <= 0) return null;
		return {
			sigma,
			mask: /* glsl */ `${picture(p)}\nvec4 tl_mask(TlSurface s) { return tl_picture(s.uv); }`,
		};
	},
	reach(p) {
		const blur = num(p.blur);
		return { left: blur, top: 0, right: blur, bottom: Math.max(0, num(p.gap)) + num(p.fade) + blur };
	},
	fieldReach: () => ({ outside: 1 }),
	handles: [{ kind: 'distance', params: ['gap'] }],
	summary(p) {
		return {
			swatch: null,
			text: `${fmtDistance(p.fade)}, ${fmtNumber(p.opacity)} %`,
			primary: 'opacity',
		};
	},
};

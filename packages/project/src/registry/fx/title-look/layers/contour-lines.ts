// `contourLines` (spec 19 §8, not in the §5.1 table: the look layer of the Contour Lines effect, so both share this GLSL).
// Ported from Pachislop's contourLines (effects/a/glow.ts): lines of light following the silhouette at even spacing,
// coloured across the title or by line number, added as light with a glow. `count` animates; lines appear one by one.
import { fmtDistance, fmtNumber, layerSwatch, lp, type TitleLayerInit } from '../contract.ts';
import { GLSL_TL_LIGHT } from '../light.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const SIGMAS = 3;

const DEPTH: Record<string, string> = { inside: '-s.d', outside: 's.d', both: 'abs(s.d)' };

const gradientPaint = (p: Record<string, unknown>) =>
	(p.paint as { kind?: string } | undefined)?.kind === 'gradient';

const lines = (p: Record<string, unknown>) => /* glsl */ `
vec4 tl_lines(TlSurface s) {
  float spacing = max(tl_px(u_spacing), 1.0);
  float inset = tl_px(u_offset);
  float depth = ${DEPTH[String(p.mode)] ?? DEPTH.inside};
  float n = max(1.0, floor(u_count + 0.5));
  float k = clamp(floor((depth - inset) / spacing + 0.5), 0.0, n - 1.0);
  float dist = abs(depth - inset - k * spacing);
  float cov = clamp(0.5 * max(tl_px(u_lineWidth), 0.5) - dist + 0.5, 0.0, 1.0);
  float pos = n > 1.0 ? k / (n - 1.0) : 0.0;
  vec4 c = ${p.colorBy === 'line' && gradientPaint(p) ? 'tl_ramp(u_paintRamp, pos)' : 'tlPaint_paint(s)'};
  return c * cov * (1.0 - u_falloff * 0.01 * pos) * s.opacity;
}`;

const hasGlow = (p: Record<string, unknown>) => num(p.glowSize) > 0;

export const CONTOUR_LINES_LAYER: TitleLayerInit = {
	type: 'contourLines',
	label: 'Contour Lines',
	description: 'Glowing lines that follow the silhouette at even spacing, inside it or around it.',
	finish: false,
	params: [
		lp.choice(
			'mode',
			'Lines',
			['inside', 'outside', 'both'],
			['Inside', 'Around', 'Inside and Around'],
			'inside',
		),
		lp.number('count', 'Line Count', 6, { min: 1, max: 40, step: 1 }),
		lp.distance('spacing', 'Spacing', 4.5, { min: 0.1, softMax: 30 }),
		lp.distance('lineWidth', 'Line Width', 1.2, { softMax: 10 }),
		lp.distance('offset', 'First Line', 2, { softMax: 30 }),
		lp.percent('falloff', 'Falloff', 60),
		...lp.paint('paint', 'Paint', {
			kind: 'gradient',
			gradient: {
				type: 'linear',
				span: 'block',
				angle: 315,
				stops: [
					{ at: 0, paint: { role: 'accent1' } },
					{ at: 0.5, paint: { role: 'accent2' } },
					{ at: 1, paint: { role: 'accent3' } },
				],
			},
		}),
		lp.choice('colorBy', 'Colour By', ['across', 'line'], ['Across the Title', 'Line Number'], 'across'),
		lp.number('intensity', 'Intensity', 1.2, { min: 0, max: 100, softMax: 6, step: 0.01 }),
		lp.distance('glowSize', 'Glow Size', 6, { softMax: 60 }),
		lp.number('glow', 'Glow Amount', 0.8, { min: 0, max: 100, softMax: 4, step: 0.01 }),
		lp.percent('dim', 'Dim Face', 0),
	],
	shader(p) {
		return {
			glsl: /* glsl */ `${lines(p)}
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  vec3 light = tl_lines(s).rgb${hasGlow(p) ? ' + texture(u_tlBlur, s.uv).rgb * u_glow' : ''};
  light = max(light * u_intensity, vec3(0.0));
  vec4 base = vec4(under.rgb * (1.0 - u_dim * 0.01), under.a);
  return tl_result(under, tl_lit(base, base.rgb + light * base.a, light));
}`,
			include: [GLSL_TL_LIGHT],
		};
	},
	blur(p) {
		if (!hasGlow(p)) return null;
		return {
			sigma: num(p.glowSize) / SIGMAS,
			mask: /* glsl */ `${lines(p)}\nvec4 tl_mask(TlSurface s) { return tl_lines(s); }`,
		};
	},
	reach(p) {
		const lastLine = num(p.offset) + (Math.max(1, Math.round(num(p.count))) - 1) * num(p.spacing);
		const outside = p.mode === 'inside' ? 0 : lastLine + num(p.lineWidth) / 2;
		return outside + num(p.glowSize);
	},
	fieldReach(p) {
		const lastLine =
			num(p.offset) + (Math.max(1, Math.round(num(p.count))) - 1) * num(p.spacing) + num(p.lineWidth);
		return {
			inside: p.mode === 'outside' ? 1 : lastLine + 1,
			outside: p.mode === 'inside' ? 1 : lastLine + 1,
		};
	},
	handles: [{ kind: 'distance', params: ['spacing'] }],
	summary(p) {
		return {
			swatch: layerSwatch(CONTOUR_LINES_LAYER, p),
			text: `${fmtNumber(p.count, 0)} lines, ${fmtDistance(p.spacing)}`,
			primary: 'spacing',
		};
	},
};

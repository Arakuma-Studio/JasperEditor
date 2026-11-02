// Corona (TL-061): energy tendrils or an aura of tongues from the edges of the shape, as light, after Pachislop's
// energy/corona.ts. The normals come from wide central differences of the distance, which stay continuous across the
// creases between letters (Pachislop blurs the field for the same reason). Standalone it wraps a disc.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { evolutionParams, GLSL_TLG, GLSL_TLG_UPSTREAM, hex, num, pct, variationParam } from './shared.ts';

const aura = (p: LayerParams) => p.style === 'aura';
const reachOf = (p: LayerParams) =>
	(aura(p) ? (p.flow === 'up' ? 2.4 : 1.5) * num(p.tongue) : num(p.tendrilLength)) + 4;

export const GENERATOR_CORONA = defineGenerator({
	id: 'corona',
	label: 'Corona',
	description: 'Flowing energy tendrils from the edges of the title, or an aura of flickering tongues.',
	keywords: ['aura', 'energy', 'tendrils', 'plasma', 'halo'],
	params: [
		lp.choice('style', 'Style', ['tendrils', 'aura'], ['Tendrils', 'Aura'], 'tendrils'),
		lp.distance('tendrilLength', 'Tendril Length', 60, { min: 1, softMax: 300 }),
		lp.percent('wispiness', 'Wispiness', 60, { range: { max: 200 } }),
		lp.number('density', 'Tendril Density', 100, { min: 20, max: 400, step: 1 }, { unit: '%' }),
		lp.choice('strength', 'Aura', ['strong', 'weak'], ['Strong', 'Weak'], 'strong'),
		lp.choice('flow', 'Direction', ['outward', 'up'], ['Outward', 'Up'], 'outward'),
		lp.distance('tongue', 'Tongue Length', 45, { min: 1, softMax: 300 }),
		lp.distance('turbulenceScale', 'Turbulence Scale', 30, { min: 1, softMax: 200 }),
		lp.percent('breakup', 'Breakup', 50),
		lp.number('edgeGlow', 'Edge Glow', 60, { min: 0, max: 200, step: 1 }, { unit: '%' }),
		lp.number('intensity', 'Intensity', 140, { min: 0, max: 400, step: 1 }, { unit: '%' }),
		...evolutionParams(0.8),
		lp.color('edgeColor', 'Edge Colour', hex('#c6f4ff')),
		lp.color('midColor', 'Middle Colour', hex('#3ab4ff')),
		lp.color('tipColor', 'Tip Colour', hex('#6a2cff')),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG, GLSL_TLG_UPSTREAM],
	shapeAware: true,
	standIn: 'disc',
	lowRes: 2,
	defines: (p) =>
		`#define TLG_CORONA_AURA ${aura(p) ? 1 : 0}\n#define TLG_CORONA_UP ${p.flow === 'up' ? 1 : 0}\n`,
	color: { role: 'glow', mode: 'light' },
	presets: [
		{ id: 'tendrils', label: 'Blue Tendrils', params: {} },
		{
			id: 'violet',
			label: 'Violet Tendrils',
			params: {
				tendrilLength: 55,
				wispiness: 70,
				density: 110,
				edgeGlow: 70,
				intensity: 150,
				edgeColor: hex('#ffd6ff'),
				midColor: hex('#c040ff'),
				tipColor: hex('#5010b0'),
				variation: 3,
			},
		},
		{ id: 'aura', label: 'Strong Aura', params: { style: 'aura' } },
		{ id: 'risingAura', label: 'Rising Aura', params: { style: 'aura', strength: 'weak', flow: 'up' } },
	],
	reach: reachOf,
	fieldReach: (p) => ({ outside: reachOf(p) + 2, inside: 12 }),
	timeDependent: (p) => num(p.speed) !== 0,
	summary: (p) => `${String(p.style)}, ${pct(aura(p) ? p.tongue : p.tendrilLength)}`,
	glsl: /* glsl */ `
vec2 tlg_normalAt(vec2 uv, float e) {
  vec2 o = vec2(e) / u_canvasSize;
  vec2 g = vec2(tlg_d(uv + vec2(o.x, 0.0)) - tlg_d(uv - vec2(o.x, 0.0)),
                tlg_d(uv + vec2(0.0, o.y)) - tlg_d(uv - vec2(0.0, o.y)));
  return normalize(g + 1.0e-6);
}
#if TLG_CORONA_AURA
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  float d = s.d;
  vec2 pc = (s.px - u_box.xy) / tl_unit() * 100.0;
  float tt = u_evolution + u_speed * u_tlTime;
  bool strong = u_strength == 0;
  float base = max(u_tongue * (strong ? 1.0 : 0.6), 1.0);
  float scale = max(u_turbulenceScale, 1.0);
  float L = base;
  float dc;
  vec2 qn, sq, qh;
#if TLG_CORONA_UP
  L *= 1.6;
  dc = tlg_upstream(s.px, vec2(0.0, -1.0), tl_px(L * 1.5), 2.0) / tl_px(1.0);
  float xs = pc.x + (tlg_fbm(vec2(pc.x / scale, -pc.y / (scale * 2.0) - tt * 0.5)) - 0.5) * dc * 0.8;
  qn = vec2(xs / scale, tt * 0.4);
  sq = vec2(xs / (scale * 0.18), -pc.y / (scale * 2.0) - tt);
  qh = vec2(xs / (scale * 0.35), -pc.y / (scale * 0.9) - tt);
#else
  vec2 nrm = tlg_normalAt(s.uv, tl_px(base * 0.3));
  dc = max(d, 0.0) / tl_px(1.0);
  vec2 q = pc - nrm * dc;
  vec2 warp = vec2(tlg_fbm(pc / scale), tlg_fbm(pc / scale + 5.1)) - 0.5;
  vec2 qw = q + warp * dc * 0.8;
  qn = qw / scale + tt * 0.1;
  sq = qw / (scale * 0.18) + tt * 0.3;
  qh = qw / (scale * 0.35) + dc / (scale * 0.9) - tt;
#endif
  float n = clamp((tlg_fbm(qn + 7.0) - 0.5) * 3.2 + 0.5, 0.0, 1.0);
  float len = L * (0.2 + 1.3 * n);
  float k = dc / max(len, 1.0);
  float tongue = pow(clamp(1.0 - k, 0.0, 1.0), 1.4);
  float streak = 0.55 + 0.45 * pow(tlg_ridge(sq + 13.0), 3.0);
  float hole = smoothstep(0.4, 0.65, tlg_fbm(qh + 29.0));
  float brk = 1.0 - min(1.0, u_breakup * 0.01 + (strong ? 0.0 : 0.3)) * hole * smoothstep(0.05, 0.5, k);
  float halo = exp(-dc / (base * 0.22)) * (u_edgeGlow * 0.01) * 0.4;
  float inner = d < 0.0 ? exp(d / max(tl_px(base * 0.08), 1.0)) : 1.0;
  float I = (tongue * streak * brk + halo) * inner * (u_intensity * 0.01) * (strong ? 1.0 : 0.55);
  float t = clamp(k * 0.85 + (1.0 - streak) * 0.1, 0.0, 1.0);
  return tlg_light(tlg_ramp3(t, tlg_rgb(u_edgeColor), tlg_rgb(u_midColor), tlg_rgb(u_tipColor)) * I);
}
#else
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  float d = s.d;
  float len = max(u_tendrilLength, 1.0);
  vec2 nrm = tlg_normalAt(s.uv, tl_px(len * 0.3));
  float dc = max(d, 0.0) / tl_px(1.0);
  vec2 pc = (s.px - u_box.xy) / tl_unit() * 100.0;
  float tt = u_evolution + u_speed * u_tlTime;
  // Nearest edge point: constant along each outward normal, so streaks run radially.
  vec2 q = pc - nrm * dc;
  // Curl grows with distance, so tendrils bend and wisp out toward their tips.
  vec2 wp = pc / (len * 0.7);
  vec2 warp = vec2(tlg_fbm(wp + vec2(0.0, -tt * 0.3)), tlg_fbm(wp + vec2(4.3, 2.1 - tt * 0.3))) - 0.5;
  vec2 qw = q + warp * (u_wispiness * 0.01) * dc * 1.1;
  float k = dc / len;
  float sc = 0.16 / max(u_density * 0.01, 0.05);
  float t1 = pow(tlg_ridge(qw / (len * sc) + vec2(tt * 0.25, -tt * 0.15)), 6.0);
  float t2 = pow(tlg_ridge(qw / (len * sc * 0.4) + vec2(-tt * 0.4, tt * 0.25) + 19.0), 14.0);
  // Pulses travelling outward along each tendril.
  float pulse = 0.55 + 0.45 * tlg_vnoise(vec2(k * 4.0 - tt * 1.6, dot(q, vec2(0.13, 0.17)) * (u_density * 0.01) * 0.8));
  float fall = pow(clamp(1.0 - k, 0.0, 1.0), 1.6);
  float tend = (t1 * 0.9 + t2 * 0.7) * pulse * fall;
  float glow = exp(-k * 7.0) * (u_edgeGlow * 0.01);
  float inner = d < 0.0 ? exp(d / max(tl_px(len * 0.06), 1.0)) : 1.0;
  float I = (tend + glow) * inner * (u_intensity * 0.01);
  float t = clamp(k + (1.0 - tend) * 0.15, 0.0, 1.0);
  return tlg_light(tlg_ramp3(t, tlg_rgb(u_edgeColor), tlg_rgb(u_midColor), tlg_rgb(u_tipColor)) * I);
}
#endif
`,
});

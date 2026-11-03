// Smoke (TL-061): soft billowing smoke rising from the edges of the shape, after Pachislop's energy/smoke.ts. The domain
// warp churns with time as the billows drift up with the flow. Standalone it rises from the bottom of the frame.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { flowReach } from './fire.ts';
import { evolutionParams, GLSL_TLG, GLSL_TLG_UPSTREAM, hex, num, pct, variationParam } from './shared.ts';

const reach = (p: LayerParams) =>
	flowReach(p, 1.45 * num(p.height), 1.45 * num(p.height) * (num(p.spread) / 100) + num(p.billow) + 4);

export const GENERATOR_SMOKE = defineGenerator({
	id: 'smoke',
	label: 'Smoke',
	description: 'Soft billowing smoke rising from the edges of the title.',
	keywords: ['fog', 'steam', 'mist', 'plume', 'energy'],
	params: [
		lp.distance('height', 'Smoke Height', 110, { softMax: 400 }),
		lp.distance('billow', 'Billow Size', 20, { min: 1, softMax: 150 }),
		lp.angle('angle', 'Direction', -90),
		lp.percent('spread', 'Side Spread', 35),
		lp.percent('softness', 'Softness', 60),
		...evolutionParams(0.5),
		lp.color('color', 'Highlight Colour', hex('#d8d2e6')),
		lp.color('shadowColor', 'Shadow Colour', hex('#4a4458')),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG, GLSL_TLG_UPSTREAM],
	shapeAware: true,
	standIn: 'ground',
	lowRes: 2,
	color: { role: 'base', mode: 'luma' },
	presets: [
		{ id: 'grey', label: 'Grey Smoke', params: {} },
		{
			id: 'steam',
			label: 'White Steam',
			params: { height: 130, billow: 25, softness: 80, color: hex('#ffffff'), shadowColor: hex('#a8b0c0') },
		},
		{
			id: 'black',
			label: 'Black Smoke',
			params: { height: 120, billow: 18, softness: 45, color: hex('#4a4448'), shadowColor: hex('#0c0a0c') },
		},
	],
	reach,
	fieldReach: (p) => {
		const r = reach(p);
		return { outside: Math.max(r.left, r.top, r.right, r.bottom) };
	},
	timeDependent: (p) => num(p.speed) !== 0,
	summary: (p) => `height ${pct(p.height)}`,
	glsl: /* glsl */ `
float tlg_soft3(vec2 p) {
  return 0.55 * tlg_vnoise(p) + 0.3 * tlg_vnoise(p * 2.07 + 9.1) + 0.15 * tlg_vnoise(p * 4.3 + 3.7);
}
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  vec2 dir = fx_dir(u_angle);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 pc = s.px - u_box.xy;
  float fy = dot(pc, dir), fx = dot(pc, perp);
  float W = max(tl_px(u_billow), 1.0);
  float Hr = max(tl_px(u_height), 1.0);
  float tt = u_evolution + u_speed * u_tlTime;
  // Billows drift up with the flow and slowly churn (domain warp).
  vec2 q = vec2(fx, fy - tt * W * 1.1) / (W * 2.0);
  vec2 w = vec2(tlg_soft3(q * 0.6 + vec2(0.0, tt * 0.12)), tlg_soft3(q * 0.6 + vec2(5.2, 1.3 - tt * 0.09))) - 0.5;
  float bil = tlg_soft3(q + w * 1.5);
  // Columns of smoke reach different heights and sway as they rise.
  float plume = tlg_soft3(vec2(fx / (W * 2.5), tt * 0.08) + 23.0);
  vec2 at = s.px + perp * w.x * W * 2.0;
  float len = Hr * (0.45 + 0.9 * plume);
  float E = tlg_upstream(at, dir, Hr * 1.4, 1.0 / max(0.08, u_spread * 0.01));
  float I = clamp(1.0 - E / max(len, 1.0), 0.0, 1.0);
  float soft = max(0.02, u_softness * 0.01);
  float dens = smoothstep(0.08, 0.08 + soft, pow(I, 0.8) * (0.3 + 1.1 * bil));
  vec3 c = mix(tlg_rgb(u_shadowColor), tlg_rgb(u_color), smoothstep(0.3, 0.75, bil));
  return vec4(c * dens, dens);
}`,
});

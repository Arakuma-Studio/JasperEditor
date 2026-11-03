// Fire (TL-061): flames rising from the edges of the shape, after Pachislop's generators/energy/fire.ts. The tongue noise
// scrolls with `u_tlTime`, so the flame is a closed form of time and seed. Colours stay fixed in a look unless the look
// asks otherwise (TL-051). Standalone it burns along the bottom of the frame.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { evolutionParams, GLSL_TLG, GLSL_TLG_UPSTREAM, hex, num, pct, variationParam } from './shared.ts';

/** How far a flow reaches: along it, and across it (side burn, sway), percent of the unit, per side. */
export function flowReach(p: LayerParams, along: number, across: number) {
	const a = (num(p.angle) * Math.PI) / 180;
	const dx = Math.cos(a);
	const dy = Math.sin(a);
	return {
		left: across + Math.max(0, -dx) * along,
		right: across + Math.max(0, dx) * along,
		top: across + Math.max(0, -dy) * along,
		bottom: across + Math.max(0, dy) * along,
	};
}

const reach = (p: LayerParams) =>
	flowReach(
		p,
		1.6 * num(p.height),
		1.6 * num(p.height) * (num(p.spread) / 100) + 0.7 * num(p.flameWidth) * (num(p.turbulence) / 100) + 4,
	);

export const GENERATOR_FIRE = defineGenerator({
	id: 'fire',
	label: 'Fire',
	description: 'Flames rising from the edges of the title: behind it, or licking over its edges.',
	keywords: ['flame', 'burn', 'blaze', 'heat', 'energy'],
	params: [
		lp.distance('height', 'Flame Height', 75, { softMax: 300 }),
		lp.distance('flameWidth', 'Flame Width', 11, { min: 0.5, softMax: 100 }),
		lp.percent('turbulence', 'Turbulence', 60, { range: { max: 150 } }),
		lp.angle('angle', 'Direction', -90),
		lp.percent('spread', 'Side Burn', 35),
		lp.toggle('overEdge', 'Over the Edges', false),
		lp.distance('inside', 'Over-Edge Depth', 6, { softMax: 50 }),
		...evolutionParams(2),
		lp.number('intensity', 'Intensity', 110, { min: 0, max: 300, step: 1 }, { unit: '%' }),
		lp.color('coreColor', 'Core Colour', hex('#fff27a')),
		lp.color('midColor', 'Middle Colour', hex('#ff8a00')),
		lp.color('tipColor', 'Tip Colour', hex('#b81000')),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG, GLSL_TLG_UPSTREAM],
	shapeAware: true,
	standIn: 'ground',
	lowRes: 2,
	color: { role: 'accent1', mode: 'luma', fixed: true },
	presets: [
		{ id: 'behind', label: 'Flames Behind', params: {} },
		{ id: 'overEdges', label: 'Over the Edges', params: { overEdge: true, height: 55 } },
		{
			id: 'blaze',
			label: 'Tall Blaze',
			params: { height: 130, flameWidth: 20, turbulence: 70, spread: 30, intensity: 90, variation: 12 },
		},
		{
			id: 'spirit',
			label: 'Spirit Fire',
			params: {
				height: 90,
				coreColor: hex('#d8fff0'),
				midColor: hex('#23c8ff'),
				tipColor: hex('#1020b0'),
				variation: 5,
			},
		},
	],
	reach,
	fieldReach: (p) => {
		const r = reach(p);
		return { outside: Math.max(r.left, r.top, r.right, r.bottom), inside: num(p.inside) + 1 };
	},
	timeDependent: (p) => num(p.speed) !== 0,
	summary: (p) => `height ${pct(p.height)}`,
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  vec2 dir = fx_dir(u_angle);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 pc = s.px - u_box.xy;
  float fy = dot(pc, dir), fx = dot(pc, perp);
  float W = max(tl_px(u_flameWidth), 1.0);
  float Hr = max(tl_px(u_height), 1.0);
  float turb = u_turbulence * 0.01;
  float tt = u_evolution + u_speed * u_tlTime;
  // Sideways sway of the whole flame body.
  float sway = tlg_fbm(vec2(fx / (W * 3.0), fy / (W * 3.5) - tt * 0.7)) - 0.5;
  vec2 at = s.px + perp * sway * W * turb * 1.4;
  float E = tlg_upstream(at, dir, Hr * 1.6, 1.0 / max(0.08, u_spread * 0.01));
  // Rising tongue noise: narrow across the flow, stretched along it, scrolling with the flow.
  float n = 0.7 * tlg_fbm(vec2(fx / W, fy / (W * 4.0) - tt * 1.1) + 11.0)
          + 0.3 * tlg_vnoise(vec2(fx / (W * 0.5), fy / (W * 1.6) - tt * 2.0) + 37.0);
  n = clamp((n - 0.5) * (1.6 + 1.6 * turb) + 0.5, 0.0, 1.0);
  // Each tongue gets its own length; fine flicker roughens only the outer part.
  float len = Hr * mix(1.0, 0.3 + 1.3 * n, clamp(turb * 1.3, 0.0, 1.0));
  float f = clamp(1.0 - E / max(len, 1.0), 0.0, 1.0);
  f += (tlg_vnoise(vec2(fx / (W * 0.3), fy / (W * 0.6) - tt * 3.0) + 61.0) - 0.5) * 0.9 * f * (1.0 - f);
  f = clamp(f, 0.0, 1.0);
  float a = smoothstep(0.0, 0.35, f);
  vec3 c = tlg_ramp3(1.0 - f, tlg_rgb(u_coreColor), tlg_rgb(u_midColor), tlg_rgb(u_tipColor));
  c = mix(c, vec3(1.0), 0.75 * smoothstep(0.82, 1.0, f)); // white-hot core
  c *= 1.0 + 0.6 * smoothstep(0.8, 1.0, f);
  vec4 fire = vec4(c * (u_intensity * 0.01) * a, a);
  // Over the edge: the flames lick over the outer band of the shape and clear inside it.
  if (u_overEdge) fire *= 1.0 - smoothstep(0.0, max(tl_px(u_inside), 1.0), max(-s.d, 0.0));
  return fire;
}`,
});

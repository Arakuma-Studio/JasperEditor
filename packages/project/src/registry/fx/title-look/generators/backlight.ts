// Backlight (TL-061): god rays streaming from behind the silhouette, after Pachislop's light/backlight.ts: the alpha
// masked by angular noise, then a coarse and a fine radial blur from the centre. Rotation turns the mask, so the rays
// sweep; Ray Length keyframes. `jasper.s.rays` beams from the bright pixels of a picture; this one needs only the shape.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG, hex, num, pct, variationParam } from './shared.ts';

const CENTRE = /* glsl */ `
vec2 tlg_centre() {
  if (u_centreMode == 1) return fx_uvOfLayerNorm(u_center) * u_canvasSize;
  vec4 b = tl_bounds();
  return 0.5 * (b.xy + b.zw);
}`;

const radial = (tex: string, len: string, falloff: boolean) => /* glsl */ `${CENTRE}
void main() {
  vec2 p = v_uv * u_canvasSize;
  vec2 toC = tlg_centre() - p;
  float dist = length(toC);
  float span = min(dist, ${len});
  vec2 dir = toC / max(dist, 1.0e-3);
  float acc = 0.0, wsum = 0.0;
  for (int i = 0; i < 40; i++) {
    float f = (float(i) + 0.5) / 40.0;
    float w = ${falloff ? 'pow(1.0 - f, 1.3)' : '1.0'};
    acc += texture(${tex}, (p + dir * span * f) / u_canvasSize).r * w;
    wsum += w;
  }
  float v = acc / wsum;
  // Rays stop at their length rather than averaging out to nothing.
  fragColor = vec4(${falloff ? `v * span / max(${len}, 1.0) * 2.0` : 'v'}, 0.0, 0.0, 1.0);
}`;

const reach = (p: LayerParams) => num(p.rayLength) * 1.03 + 2;

export const GENERATOR_BACKLIGHT = defineGenerator({
	id: 'backlight',
	label: 'Backlight',
	description: 'God rays streaming from behind the title, rotating, from its centre or a chosen point.',
	keywords: ['god rays', 'light rays', 'volumetric', 'halo', 'beams'],
	params: [
		lp.choice('centreMode', 'Light Centre', ['shape', 'point'], ['Title Centre', 'Point'], 'shape'),
		lp.point('center', 'Centre Point', [0.5, 0.5]),
		lp.distance('rayLength', 'Ray Length', 130, { min: 1, softMax: 600 }),
		lp.number('intensity', 'Intensity', 180, { min: 0, max: 600, step: 1 }, { unit: '%' }),
		lp.color('color', 'Inner Colour', hex('#fff6d0')),
		lp.color('outerColor', 'Outer Colour', hex('#ffa318')),
		lp.number('rayCount', 'Ray Count', 36, { min: 2, max: 120, step: 1 }),
		lp.percent('rayNoise', 'Ray Noise', 90),
		lp.angle('rotation', 'Rotation', 0),
		lp.number(
			'spin',
			'Spin',
			8,
			{ min: -360, max: 360, softMin: -60, softMax: 60, step: 0.1 },
			{ unit: 'deg' },
		),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	shapeAware: true,
	standIn: 'disc',
	usesBounds: () => true,
	color: { role: 'glow', mode: 'light' },
	presets: [
		{ id: 'godRays', label: 'God Rays', params: {} },
		{
			id: 'warm',
			label: 'Warm Burst',
			params: { rayLength: 100, intensity: 130, outerColor: hex('#ff9a10'), rayCount: 40, variation: 3 },
		},
		{
			id: 'blue',
			label: 'Blue Rays',
			params: {
				rayLength: 160,
				intensity: 200,
				color: hex('#e6f6ff'),
				outerColor: hex('#2a8aff'),
				rayCount: 28,
				rayNoise: 80,
			},
		},
	],
	reach,
	fieldReach: () => ({ outside: 1 }),
	timeDependent: (p) => num(p.spin) !== 0,
	summary: (p) => `length ${pct(p.rayLength)}, ${num(p.rayCount)} rays`,
	prepass: (_p, c) => {
		const half = { format: 'rgba16f' as const, scale: 0.5 };
		return [
			c.pass({
				...half,
				output: 'tlGenA',
				frag: /* glsl */ `${CENTRE}
void main() {
  tlg_begin();
  TlSurface s = tl_surface();
  vec2 d = s.px - tlg_centre();
  float ang = atan(d.y, d.x) + radians(u_rotation + u_spin * u_tlTime);
  vec2 cdir = vec2(cos(ang), sin(ang));
  float rad = u_rayCount / 6.2831853;
  float n = 0.6 * tlg_vnoise(cdir * rad + 3.0) + 0.4 * tlg_vnoise(cdir * rad * 2.7 + 11.0);
  float mask = mix(1.0, pow(smoothstep(0.25, 0.85, n), 1.5) * 1.8, u_rayNoise * 0.01);
  fragColor = vec4(s.alpha * mask, 0.0, 0.0, 1.0);
}`,
			}),
			c.pass({
				...half,
				output: 'tlGenB',
				frag: radial('u_tlGenA', 'max(tl_px(u_rayLength), 1.0)', true),
			}),
			c.pass({
				...half,
				output: 'tlGenA',
				frag: radial('u_tlGenB', '(max(tl_px(u_rayLength), 1.0) / 40.0)', false),
			}),
		];
	},
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) {
  float r = texture(u_tlGenA, s.uv).r * (u_intensity * 0.01);
  return tlg_light(mix(tlg_rgb(u_outerColor), tlg_rgb(u_color), clamp(r, 0.0, 1.0)) * r);
}`,
});

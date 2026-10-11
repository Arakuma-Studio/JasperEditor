// Simulation ▸ Ball Action, Scatterize, Hair (After Effects' CC Ball Action, CC Scatterize,
// CC Hair). The layer's own pixels become balls, scattered dots or hair strands; positions are closed-form functions
// of the pixel/grid index computed in the vertex shader (colours read from the layer there), balls drawn far to near
// after a GPU sort. Ported from EffectCraft crates/effects/src/sim2.rs (ball_action_plan, scatterize_plan) and
// sim3.rs (hair_plan; MIT OR Apache-2.0), see licenses/ported/sim-warp.md.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import { n, popup, randomSeedParam } from './common.ts';
import { num } from './core.ts';
import { GLSL_SORTED, gpuSortPasses } from './sort.ts';
import { GLSL_SPRITES, SPRITE_FRAG_MAIN, SPRITE_VERT_DECLS } from './sprites.ts';

const SIM = 'Simulation';

const AXES = ['X Axis', 'Y Axis', 'Z Axis', 'XY Axis', 'XZ Axis', 'YZ Axis', 'XYZ Axis'] as const;
const TWIST = ['X Axis', 'Y Axis', 'Radius', 'Brightness', 'Red', 'Green', 'Blue', 'Alpha'] as const;

const BALL_GLSL = /* glsl */ `
float ba_spacing() { return max(u_gridSpacing, 1.0); }
ivec2 ba_grid() { vec2 L = u_box.zw / u_pxScale; return ivec2(max(ceil(L / ba_spacing()), vec2(1.0))); }
mat3 ba_rot(vec3 a, float ang) {
  a = normalize(a);
  float s = sin(ang), c = cos(ang), t = 1.0 - c;
  return mat3(t * a.x * a.x + c, t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y,
              t * a.x * a.y - s * a.z, t * a.y * a.y + c, t * a.y * a.z + s * a.x,
              t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c);
}
// Ball id: screen centre (layer px), radius (layer px), depth z, colour (straight) — alpha 0 = no ball.
void ba_ball(int i, out vec2 sp, out float r, out float z, out vec4 col) {
  ivec2 g = ba_grid();
  float spc = ba_spacing();
  vec2 L = u_box.zw / u_pxScale;
  vec2 gp = vec2(float(i % g.x), float(i / g.x)) * spc + spc * 0.5;
  col = fx_unpremultiply(textureLod(u_source, (u_box.xy + gp * u_pxScale) / u_canvasSize, 0.0));
  sp = vec2(0.0); r = 0.0; z = 0.0;
  if (col.a <= 0.0 || u_ballSize <= 0.0 || i >= g.x * g.y) { col = vec4(0.0); return; }
  uint s = fx_pcg(fx_seedBits(u_seed) ^ 0x2545u);
  vec2 c = L * 0.5;
  float maxr = max(length(L) * 0.5, 1.0);
  float tp = gp.x / max(L.x, 1.0);
  if (u_twistProperty == 1) tp = gp.y / max(L.y, 1.0);
  else if (u_twistProperty == 2) tp = length(gp - c) / maxr;
  else if (u_twistProperty == 3) tp = fx_luma(col.rgb);
  else if (u_twistProperty == 4) tp = col.r;
  else if (u_twistProperty == 5) tp = col.g;
  else if (u_twistProperty == 6) tp = col.b;
  else if (u_twistProperty == 7) tp = col.a;
  float ang = radians(u_rotation) + radians(u_twistAngle) * tp;
  float ph = sp_h(i, 1, s) * 6.2831853 + radians(u_instabilityState);
  float sc = u_scatter * sp_h(i, 2, s);
  vec3 off = vec3(sc * cos(ph), sc * sin(ph), u_scatter * sp_hs(i, 3, s));
  vec3 p0 = vec3(gp - c + off.xy, off.z);
  vec3 ax = u_rotationAxis == 0 ? vec3(1.0, 0.0, 0.0) : u_rotationAxis == 1 ? vec3(0.0, 1.0, 0.0) : u_rotationAxis == 2 ? vec3(0.0, 0.0, 1.0)
    : u_rotationAxis == 3 ? vec3(1.0, 1.0, 0.0) : u_rotationAxis == 4 ? vec3(1.0, 0.0, 1.0) : u_rotationAxis == 5 ? vec3(0.0, 1.0, 1.0) : vec3(1.0);
  vec3 q = ba_rot(ax, ang) * p0;
  float d = 2.0 * max(L.x, L.y);
  if (d + q.z <= d * 0.05) { col = vec4(0.0); return; }
  float persp = d / (d + q.z);
  sp = c + q.xy * persp;
  r = spc * 0.5 * u_ballSize / 100.0 * persp;
  z = q.z;
}
`;

export const BALL_ACTION = defineShaderEffect({
	id: 'jasper.ball-action',
	label: 'Ball Action',
	category: SIM,
	description:
		'Turns the layer into a grid of shaded 3D balls coloured by its pixels, which scatter and twist in space.',
	keywords: ['balls', 'spheres', 'dots', 'grid', 'cc ball action'],
	params: [
		n('scatter', 'Scatter', 0, 0, 2000, 0, 300, 0.1),
		popup('rotationAxis', 'Rotation Axis', AXES),
		fxParam.angle('rotation', 'Rotation', 0),
		popup('twistProperty', 'Twist Property', TWIST),
		fxParam.angle('twistAngle', 'Twist Angle', 0),
		n('gridSpacing', 'Grid Spacing', 4, 1, 200, 1, 50, 1, { unit: 'px' }),
		n('ballSize', 'Ball Size', 40, 0, 400, 0, 200, 0.1),
		fxParam.angle('instabilityState', 'Instability State', 0),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		passes: (p, ctx) => {
			const spc = Math.max(1, num(p.gridSpacing, 4));
			const count = Math.min(1 << 20, Math.ceil(ctx.width / spc) * Math.ceil(ctx.height / spc));
			return [
				...gpuSortPasses({
					count,
					include: [GLSL_SPRITES, GLSL_COLOR],
					keyGlsl: /* glsl */ `${BALL_GLSL}
float sw_sortKey(int id) { vec2 sp; float r; float z; vec4 col; ba_ball(id, sp, r, z, col); return col.a > 0.0 ? -z : 3.0e38; }`,
				}),
				{
					include: [GLSL_SPRITES, GLSL_COLOR, GLSL_SORTED],
					draw: {
						vertices: 6,
						instances: count,
						vert: /* glsl */ `${BALL_GLSL}${SPRITE_VERT_DECLS}
void main() {
  vec2 sp; float r; float z; vec4 col;
  ba_ball(sw_sortedId(gl_InstanceID), sp, r, z, col);
  sp_emitSprite(gl_VertexID, u_box.xy + sp * u_pxScale, 2, r * u_pxScale, 0.0, vec2(0.0), col);
}`,
					},
					frag: SPRITE_FRAG_MAIN,
				},
			];
		},
	},
});

export const SCATTERIZE = defineShaderEffect({
	id: 'jasper.scatterize',
	label: 'Scatterize',
	category: SIM,
	description: 'Scatters the layer into its pixels, twisting the left and right halves into depth.',
	keywords: ['scatter', 'pixels', 'disperse', 'dust', 'cc scatterize'],
	params: [
		n('scatter', 'Scatter', 0, 0, 1000, 0, 200, 0.1, { unit: 'px' }),
		fxParam.angle('rightTwist', 'Right Twist', 0),
		fxParam.angle('leftTwist', 'Left Twist', 0),
		popup('transferMode', 'Transfer Mode', ['Composite', 'Add']),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		uniforms: (p) => ({
			// Nothing moves: the layer as is (exactly).
			u_still: num(p.scatter) === 0 && num(p.rightTwist) === 0 && num(p.leftTwist) === 0,
		}),
		passes: (_p, ctx) => {
			const w = Math.max(1, Math.round(ctx.width * ctx.pxScale));
			const h = Math.max(1, Math.round(ctx.height * ctx.pxScale));
			return [
				{
					output: 'dots',
					include: [GLSL_SPRITES],
					draw: {
						vertices: 6,
						instances: Math.min(w * h, 1 << 22),
						blend: 'over',
						vert: /* glsl */ `${SPRITE_VERT_DECLS}
void main() {
  if (u_still) { fx_cull(); return; }
  int i = gl_InstanceID;
  int w = int(round(u_box.z));
  vec2 xy = u_box.xy + vec2(float(i % w), float(i / w)) + 0.5;
  vec4 px = texelFetch(u_source, ivec2(xy), 0);
  if (px.a <= 0.0) { fx_cull(); return; }
  uint s = fx_pcg(fx_seedBits(u_seed) ^ 0x7febu);
  vec2 c = u_box.xy + u_box.zw * 0.5;
  float half_ = max(u_box.z * 0.5, 1.0);
  float d = 2.0 * max(u_box.z, u_box.w);
  float k = min(abs(xy.x - c.x) / half_, 1.0);
  float ang = radians(xy.x < c.x ? u_leftTwist : u_rightTwist) * k;
  float yy = (xy.y - c.y) * cos(ang);
  float zz = (xy.y - c.y) * sin(ang);
  float persp = d / max(d + zz, d * 0.05);
  vec2 q = vec2(c.x + (xy.x - c.x) * persp + sp_hs(i, 1, s) * u_scatter * u_pxScale, c.y + yy * persp + sp_hs(i, 2, s) * u_scatter * u_pxScale);
  sp_emitSprite(gl_VertexID, q, 1, 0.6 * persp, 0.0, vec2(0.0), fx_unpremultiply(px));
}`,
					},
					frag: SPRITE_FRAG_MAIN,
				},
				{
					frag: /* glsl */ `
void main() {
  if (u_still) { fragColor = texture(u_source, v_uv); return; }
  fragColor = texture(u_dots, v_uv);
}`,
				},
			];
		},
	},
});

/** Segments per strand. */
const HAIR_SEGS = 6;

export const HAIR = defineShaderEffect({
	id: 'jasper.hair',
	label: 'Hair',
	category: SIM,
	description:
		'Grows shaded hair or fur from the layer, coloured by it, drooping with weight and combed by a map.',
	keywords: ['fur', 'hair', 'grass', 'strands', 'cc hair'],
	params: [
		n('length', 'Length', 30, 0, 2000, 0, 200, 0.1, { unit: 'px' }),
		n('thickness', 'Thickness', 1, 0.05, 20, 0.1, 5),
		n('weight', 'Weight', 0.2, -10, 10, -2, 2),
		fxParam.toggle('constantMass', 'Constant Mass', false),
		n('density', 'Density', 100, 0, 10000, 0, 1000, 0.1),
		fxParam.percent('mapStrength', 'Map Strength', 0, { group: 'Hairfall Map' }),
		fxParam.media('mapLayer', 'Map Layer', ['image', 'video'], { group: 'Hairfall Map' }),
		n('mapSoftness', 'Map Softness', 0, 0, 1000, 0, 100, 0.1, { group: 'Hairfall Map', unit: 'px' }),
		fxParam.percent('addNoise', 'Add Noise', 0, { group: 'Hairfall Map' }),
		fxParam.color('hairColor', 'Color', [0.35, 0.25, 0.15, 1], { group: 'Hair Color' }),
		n('brightness', 'Brightness', 100, 0, 4000, 0, 400, 0.1, { group: 'Hair Color', unit: '%' }),
		fxParam.percent('opacity', 'Opacity', 100, { group: 'Hair Color' }),
		fxParam.percent('colorInheritance', 'Color Inheritance', 0, { group: 'Hair Color' }),
		n('lightIntensity', 'Light Intensity', 100, 0, 4000, 0, 400, 0.1, { group: 'Light', unit: '%' }),
		fxParam.angle('lightDirection', 'Light Direction', -45, { group: 'Light' }),
		fxParam.percent('ambient', 'Ambient', 40, { group: 'Shading' }),
		fxParam.percent('diffuse', 'Diffuse', 60, { group: 'Shading' }),
		fxParam.percent('specular', 'Specular', 30, { group: 'Shading' }),
		fxParam.percent('roughness', 'Roughness', 20, { group: 'Shading' }),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => {
			const len = Math.max(0, num(p.length, 30));
			const density = Math.max(0, num(p.density, 100)) / 100;
			const strands =
				len > 0 && density > 0
					? Math.min(200000, Math.floor(((ctx.width * ctx.height) / 1000) * density * 10))
					: 0;
			return { u_strands: { int: strands } };
		},
		passes: [
			{
				output: 'hair',
				include: [GLSL_SPRITES, GLSL_COLOR],
				draw: {
					vertices: 6 * HAIR_SEGS,
					instances: { uniform: 'u_strands' },
					vert: /* glsl */ `${SPRITE_VERT_DECLS}
float hr_lum(vec2 lp) {
  vec4 c = fx_unpremultiply(textureLod(u_mapLayer, lp / (u_box.zw / u_pxScale), 0.0));
  return fx_luma(c.rgb) * c.a;
}
void main() {
  int i = gl_InstanceID;
  int seg = gl_VertexID / 6;
  int v = gl_VertexID % 6;
  uint s = fx_pcg(fx_seedBits(u_seed) ^ 0x85ebu);
  float sc = u_pxScale;
  vec2 L = u_box.zw / sc;
  vec2 root = vec2(sp_h(i, 1, s) * L.x, sp_h(i, 2, s) * L.y);
  vec4 rc = textureLod(u_source, (u_box.xy + root * sc) / u_canvasSize, 0.0);
  if (rc.a < 0.5) { fx_cull(); v_d = vec2(0.0); v_seg = vec2(0.0); v_shape = 0; v_col = vec4(0.0); v_rr = vec2(0.0); return; }
  float l = u_length * (0.75 + 0.5 * sp_h(i, 3, s));
  vec2 lean = vec2(sp_hs(i, 4, s) * 0.6, -1.0 + sp_h(i, 5, s) * 0.4);
  if (u_mapLayer_size.x > 0.0) {
    float ms = u_mapStrength / 100.0;
    float d = max(u_mapSoftness, 1.0);
    vec2 g = vec2(hr_lum(root + vec2(d, 0.0)) - hr_lum(root - vec2(d, 0.0)), hr_lum(root + vec2(0.0, d)) - hr_lum(root - vec2(0.0, d)));
    l *= 1.0 - ms + ms * hr_lum(root);
    lean += g * ms * 4.0;
    if (u_addNoise > 0.0) lean.x += sp_hs(i, 6, s) * u_addNoise / 100.0;
  }
  vec2 dir = normalize(lean + vec2(1e-6));
  float droop = u_weight * (u_constantMass ? 1.0 : 1.0 / max(u_thickness, 0.2)) * l;
  float s0 = float(seg) / ${HAIR_SEGS}.0, s1 = float(seg + 1) / ${HAIR_SEGS}.0;
  vec2 a = root + dir * l * s0 + vec2(0.0, droop * s0 * s0);
  vec2 b = root + dir * l * s1 + vec2(0.0, droop * s1 * s1);
  vec2 t = normalize(b - a + vec2(1e-6));
  vec2 ld = vec2(sin(radians(u_lightDirection)), -cos(radians(u_lightDirection)));
  float tl = dot(t, ld);
  float diff = sqrt(max(1.0 - tl * tl, 0.0));
  float rough = clamp(u_roughness / 100.0, 0.01, 1.0);
  float li = u_lightIntensity / 100.0;
  float spec = pow(1.0 - abs(tl), 1.0 / rough) * u_specular / 100.0 * li;
  float shade = (u_ambient / 100.0 + u_diffuse / 100.0 * diff * li) * u_brightness / 100.0;
  vec3 root3 = fx_unpremultiply(rc).rgb;
  vec3 base = mix(u_hairColor.rgb, root3, u_colorInheritance / 100.0);
  vec4 c = vec4(base * shade + spec, u_opacity / 100.0);
  sp_emitSprite(v, u_box.xy + a * sc, 8, u_thickness * 0.5 * sc * (1.0 - 0.6 * s1), 0.0, (b - a) * sc, c);
}`,
				},
				frag: SPRITE_FRAG_MAIN,
			},
			{
				include: [GLSL_SPRITES],
				frag: /* glsl */ `
void main() { fragColor = sp_combine(0, texture(u_source, v_uv), texture(u_hair, v_uv)); }`,
			},
		],
	},
});

export const PIXEL_FX_EFFECTS: readonly EffectSpec[] = [BALL_ACTION, SCATTERIZE, HAIR];

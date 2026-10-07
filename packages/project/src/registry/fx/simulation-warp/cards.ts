// Simulation ▸ Card Dance, Pixel Polly; Transition ▸ Card Wipe (sim-warp workstream; After Effects' Card Dance,
// CC Pixel Polly and Card Wipe). Layer pieces in 3D through pieces.ts. Ported from EffectCraft
// crates/effects/src/sim2.rs (card_dance_plan, pixel_polly_plan) and transition.rs (card_wipe_plan; MIT OR
// Apache-2.0), see licenses/ported/sim-warp.md.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import { n, popup, randomSeedParam, values } from './common.ts';
import { bool, choice, num } from './core.ts';
import { cameraParams, intOf, lightingParams, materialParams, piecePasses, pieceUniforms } from './pieces.ts';

const SIM = 'Simulation';

// ---------------------------------------------------------------- Card Dance

const CD_SOURCES = [
	'None',
	'Intensity 1',
	'Red 1',
	'Green 1',
	'Blue 1',
	'Alpha 1',
	'Intensity 2',
	'Red 2',
	'Green 2',
	'Blue 2',
	'Alpha 2',
] as const;
const CD_PROPS = [
	['xPosition', 'X Position'],
	['yPosition', 'Y Position'],
	['zPosition', 'Z Position'],
	['xRotation', 'X Rotation'],
	['yRotation', 'Y Rotation'],
	['zRotation', 'Z Rotation'],
	['xScale', 'X Scale'],
	['yScale', 'Y Scale'],
] as const;

/** Rows × columns of a card grid ("Columns Follows Rows" copies Rows). */
const gridOf = (p: Record<string, unknown>, rowsDefault: number) => {
	const rows = intOf(p.rows, rowsDefault, 1, 1000);
	const follows = choice(p.rowsColumns, values(['Independent', 'Columns Follows Rows'])) === 1;
	return { rows, cols: follows ? rows : intOf(p.columns, rowsDefault, 1, 1000) };
};

const CARD_DANCE_GLSL = /* glsl */ `
float cd_source(int src, vec4 g1, vec4 g2) {
  vec4 a = fx_unpremultiply(g1);
  vec4 b = fx_unpremultiply(g2);
  if (src == 1) return fx_luma(a.rgb);
  if (src == 2) return a.r;
  if (src == 3) return a.g;
  if (src == 4) return a.b;
  if (src == 5) return a.a;
  if (src == 6) return fx_luma(b.rgb);
  if (src == 7) return b.r;
  if (src == 8) return b.g;
  if (src == 9) return b.b;
  if (src == 10) return b.a;
  return 0.0;
}
vec2 cd_cell() { return u_box.zw / vec2(float(u_gridCols), float(u_gridRows)); }
int pc_count() { return u_gridRows * u_gridCols; }
int pc_n(int id) { return id < u_gridRows * u_gridCols ? 4 : 0; }
vec2 pc_vertex(int id, int k) {
  vec2 cw = cd_cell();
  vec2 o = u_box.xy + vec2(float(id % u_gridCols), float(id / u_gridCols)) * cw;
  return o + vec2(k == 1 || k == 2 ? cw.x : 0.0, k >= 2 ? cw.y : 0.0);
}
vec4 cd_grad(highp sampler2D t, vec2 tsize, vec2 uv) {
  return tsize.x > 0.0 ? textureLod(t, uv, 0.0) : textureLod(u_source, uv, 0.0);
}
void pc_place(int id, out vec2 c0, out mat3 R, out vec3 pos, out vec4 fc, out float alpha, out float extrude, out int mir) {
  vec2 cw = cd_cell();
  c0 = u_box.xy + (vec2(float(id % u_gridCols), float(id / u_gridCols)) + 0.5) * cw;
  vec2 uv = c0 / u_canvasSize;
  vec2 ln = (c0 - u_box.xy) / u_box.zw;
  vec4 g1 = cd_grad(u_gradientLayer1, u_gradientLayer1_size, ln);
  vec4 g2 = cd_grad(u_gradientLayer2, u_gradientLayer2_size, ln);
  float px = u_xPositionOffset + u_xPositionMultiplier * cd_source(u_xPositionSource, g1, g2);
  float py = u_yPositionOffset + u_yPositionMultiplier * cd_source(u_yPositionSource, g1, g2);
  float pz = u_zPositionOffset + u_zPositionMultiplier * cd_source(u_zPositionSource, g1, g2);
  float ax = radians(u_xRotationOffset + u_xRotationMultiplier * cd_source(u_xRotationSource, g1, g2));
  float ay = radians(u_yRotationOffset + u_yRotationMultiplier * cd_source(u_yRotationSource, g1, g2));
  float az = radians(u_zRotationOffset + u_zRotationMultiplier * cd_source(u_zRotationSource, g1, g2));
  float sx = u_xScaleOffset + u_xScaleMultiplier * cd_source(u_xScaleSource, g1, g2);
  float sy = u_yScaleOffset + u_yScaleMultiplier * cd_source(u_yScaleSource, g1, g2);
  mat3 r = pc_rz(az) * pc_ry(ay) * pc_rx(ax);
  R = r * mat3(sx, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 1.0);
  pos = vec3(c0 + vec2(px, py) * cw, pz * max(cw.x, cw.y));
  fc = vec4(0.0);
  alpha = 1.0;
  extrude = 0.0;
  mir = 0;
}
vec4 pc_front(vec2 t, int id) { return texture(u_source, t / u_canvasSize); }
vec4 pc_back(vec2 t, int id) {
  return u_backLayer_size.x > 0.0 ? texture(u_backLayer, (t - u_box.xy) / u_box.zw) : texture(u_source, t / u_canvasSize);
}
vec3 pc_sideColor(vec2 t, int id) { return vec3(0.0); }
`;

export const CARD_DANCE = defineShaderEffect({
	id: 'jasper.card-dance',
	label: 'Card Dance',
	category: SIM,
	description:
		'Cuts the layer into a grid of cards whose position, rotation and scale are driven by the brightness or channels of gradient layers.',
	keywords: ['cards', 'tiles', 'flip', '3d', 'grid', 'mosaic'],
	params: [
		popup('rowsColumns', 'Rows & Columns', ['Independent', 'Columns Follows Rows']),
		n('rows', 'Rows', 10, 1, 1000, 1, 100, 1),
		n('columns', 'Columns', 10, 1, 1000, 1, 100, 1),
		fxParam.media('backLayer', 'Back Layer'),
		fxParam.media('gradientLayer1', 'Gradient Layer 1'),
		fxParam.media('gradientLayer2', 'Gradient Layer 2'),
		...CD_PROPS.flatMap(([k, label], i) => {
			const rot = i >= 3 && i < 6;
			const scale = i >= 6;
			const [lo, hi, s] = rot ? [-3600, 3600, 360] : [-100, 100, 10];
			return [
				popup(`${k}Source`, 'Source', CD_SOURCES, 0, label),
				n(`${k}Multiplier`, 'Multiplier', 0, lo, hi, -s, s, 0.01, { group: label }),
				n(`${k}Offset`, 'Offset', scale ? 1 : 0, lo, hi, -s, s, 0.01, { group: label }),
			];
		}),
		...cameraParams(2),
		...lightingParams(1, 0.25),
		...materialParams(0.75),
	],
	expensive: true,
	gpu: {
		uniforms: (p, ctx) => {
			const g = gridOf(p, 10);
			return {
				...pieceUniforms(p, ctx),
				u_gridRows: { int: g.rows },
				u_gridCols: { int: g.cols },
				u_post: { int: 5 },
			};
		},
		passes: (p) => {
			const g = gridOf(p, 10);
			return piecePasses({ count: g.rows * g.cols, pieceGlsl: CARD_DANCE_GLSL, include: [GLSL_COLOR] });
		},
	},
});

// ---------------------------------------------------------------- Card Wipe

const FLIP_ORDERS = [
	'Left to Right',
	'Right to Left',
	'Top to Bottom',
	'Bottom to Top',
	'Top Left to Bottom Right',
	'Top Right to Bottom Left',
	'Bottom Left to Top Right',
	'Bottom Right to Top Left',
	'Gradient',
] as const;

const CARD_WIPE_GLSL = /* glsl */ `
vec2 cw_cell() { return u_box.zw / vec2(float(u_gridCols), float(u_gridRows)); }
float cw_h(int i, int j, uint k) { return fx_hashU(fx_pcg(uint(i) * 73856093u ^ uint(j) * 19349663u ^ u_seedBits ^ k)); }
float cw_jit(int i, int j, uint k, float speed) {
  float ph = cw_h(i, j, k) * 6.2831853;
  float rate = 0.5 + cw_h(i, j, k + 101u);
  return sin(u_time * speed * rate * 6.2831853 + ph);
}
int pc_count() { return u_gridRows * u_gridCols; }
int pc_n(int id) { return id < u_gridRows * u_gridCols ? 4 : 0; }
vec2 pc_vertex(int id, int k) {
  vec2 cw = cw_cell();
  vec2 c = u_box.xy + (vec2(float(id % u_gridCols), float(id / u_gridCols)) + 0.5) * cw;
  vec2 hs = cw * 0.5 * min(u_cardScale, 1.0) / max(u_cardScale, 1.0);
  return c + vec2(k == 1 || k == 2 ? hs.x : -hs.x, k >= 2 ? hs.y : -hs.y);
}
void pc_place(int id, out vec2 c0, out mat3 R, out vec3 pos, out vec4 fc, out float alpha, out float extrude, out int mir) {
  int i = id % u_gridCols;
  int j = id / u_gridCols;
  vec2 cw = cw_cell();
  c0 = u_box.xy + (vec2(float(i), float(j)) + 0.5) * cw;
  float nx = u_gridCols > 1 ? float(i) / float(u_gridCols - 1) : 0.0;
  float ny = u_gridRows > 1 ? float(j) / float(u_gridRows - 1) : 0.0;
  float o = nx;
  if (u_flipOrder == 1) o = 1.0 - nx;
  else if (u_flipOrder == 2) o = ny;
  else if (u_flipOrder == 3) o = 1.0 - ny;
  else if (u_flipOrder == 4) o = (nx + ny) * 0.5;
  else if (u_flipOrder == 5) o = (1.0 - nx + ny) * 0.5;
  else if (u_flipOrder == 6) o = (nx + 1.0 - ny) * 0.5;
  else if (u_flipOrder == 7) o = 1.0 - (nx + ny) * 0.5;
  else if (u_flipOrder == 8) {
    vec2 ln = (c0 - u_box.xy) / u_box.zw;
    vec4 g = u_gradientLayer_size.x > 0.0 ? textureLod(u_gradientLayer, ln, 0.0) : textureLod(u_source, c0 / u_canvasSize, 0.0);
    o = clamp(fx_luma(fx_unpremultiply(g).rgb), 0.0, 1.0);
  }
  if (u_timingRandomness > 0.0) o += (cw_h(i, j, 0x7177u) - o) * u_timingRandomness;
  float tw = clamp(u_transitionWidth / 100.0, 0.01, 1.0);
  float p = clamp((u_transitionCompletion / 100.0 - o * (1.0 - tw)) / tw, 0.0, 1.0);
  bool aroundX = u_flipAxis == 0 || (u_flipAxis == 2 && cw_h(i, j, 0x55u) < 0.5);
  float sg = (u_flipDirection == 1 || (u_flipDirection == 2 && cw_h(i, j, 0x99u) < 0.5)) ? -1.0 : 1.0;
  float a = p * 3.14159265 * sg;
  mat3 flip = aroundX ? pc_rx(a) : pc_ry(a);
  mat3 jr = pc_rz(radians(u_zRotJitterAmount * cw_jit(i, j, 13u, u_rotJitterSpeed)))
    * pc_ry(radians(u_yRotJitterAmount * cw_jit(i, j, 12u, u_rotJitterSpeed)))
    * pc_rx(radians(u_xRotJitterAmount * cw_jit(i, j, 11u, u_rotJitterSpeed)));
  float k = max(u_cardScale, 1.0);
  R = jr * flip * mat3(k, 0.0, 0.0, 0.0, k, 0.0, 0.0, 0.0, 1.0);
  pos = vec3(c0 + vec2(u_xJitterAmount * cw_jit(i, j, 21u, u_jitterSpeed) * cw.x, u_yJitterAmount * cw_jit(i, j, 22u, u_jitterSpeed) * cw.y),
             u_zJitterAmount * cw_jit(i, j, 23u, u_jitterSpeed) * max(cw.x, cw.y));
  fc = vec4(0.0);
  alpha = 1.0;
  extrude = 0.0;
  mir = aroundX ? 1 : 2;
}
vec4 pc_front(vec2 t, int id) { return texture(u_source, t / u_canvasSize); }
vec4 pc_back(vec2 t, int id) {
  if (u_backLayer_size.x <= 0.0) return vec4(-1.0);
  return texture(u_backLayer, (t - u_box.xy) / u_box.zw);
}
vec3 pc_sideColor(vec2 t, int id) { return vec3(0.0); }
`;

export const CARD_WIPE = defineShaderEffect({
	id: 'jasper.card-wipe',
	label: 'Card Wipe',
	category: 'Transition',
	description:
		'The layer is cut into cards that flip over in turn, revealing the Back Layer (or what is below), seen in 3D.',
	keywords: ['cards', 'flip', 'wipe', 'transition', '3d'],
	params: [
		fxParam.percent('transitionCompletion', 'Transition Completion', 0),
		n('transitionWidth', 'Transition Width', 50, 1, 100, 1, 100, 0.1, { unit: '%' }),
		fxParam.media('backLayer', 'Back Layer'),
		popup('rowsColumns', 'Rows & Columns', ['Independent', 'Columns Follows Rows']),
		n('rows', 'Rows', 8, 1, 1000, 1, 100, 1),
		n('columns', 'Columns', 8, 1, 1000, 1, 100, 1),
		n('cardScale', 'Card Scale', 1, 0.01, 10, 0.01, 2),
		popup('flipAxis', 'Flip Axis', ['X', 'Y', 'Random']),
		popup('flipDirection', 'Flip Direction', ['Positive', 'Negative', 'Random']),
		popup('flipOrder', 'Flip Order', FLIP_ORDERS),
		fxParam.media('gradientLayer', 'Gradient Layer'),
		n('timingRandomness', 'Timing Randomness', 0, 0, 1, 0, 1),
		randomSeedParam(1),
		...cameraParams(2),
		...lightingParams(1, 0.25),
		...materialParams(0.75),
		n('xJitterAmount', 'X Jitter Amount', 0, 0, 100, 0, 5, 0.01, { group: 'Position Jitter' }),
		n('jitterSpeed', 'Jitter Speed', 1, 0, 100, 0, 10, 0.01, { group: 'Position Jitter' }),
		n('yJitterAmount', 'Y Jitter Amount', 0, 0, 100, 0, 5, 0.01, { group: 'Position Jitter' }),
		n('zJitterAmount', 'Z Jitter Amount', 0, 0, 100, 0, 5, 0.01, { group: 'Position Jitter' }),
		n('xRotJitterAmount', 'X Rot Jitter Amount', 0, 0, 360, 0, 90, 0.1, { group: 'Rotation Jitter' }),
		n('rotJitterSpeed', 'Rot Jitter Speed', 1, 0, 100, 0, 10, 0.01, { group: 'Rotation Jitter' }),
		n('yRotJitterAmount', 'Y Rot Jitter Amount', 0, 0, 360, 0, 90, 0.1, { group: 'Rotation Jitter' }),
		n('zRotJitterAmount', 'Z Rot Jitter Amount', 0, 0, 360, 0, 90, 0.1, { group: 'Rotation Jitter' }),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const g = gridOf(p, 8);
			return {
				...pieceUniforms(p, ctx),
				u_gridRows: { int: g.rows },
				u_gridCols: { int: g.cols },
				u_post: { int: 5 },
				u_seedBits: { int: Math.floor(ctx.seed * 2147483647) },
			};
		},
		passes: (p) => {
			const g = gridOf(p, 8);
			return piecePasses({
				count: g.rows * g.cols,
				pieceGlsl: CARD_WIPE_GLSL.replaceAll('u_seedBits', 'uint(u_seedBits)'),
				include: [GLSL_COLOR],
			});
		},
	},
});

// ---------------------------------------------------------------- Pixel Polly

const POLLY_OBJECTS = ['Polygon', 'Textured Polygon', 'Square', 'Textured Square'] as const;

const PIXEL_POLLY_GLSL = /* glsl */ `
int pp_per() { return u_object <= 1 ? 2 : 1; }
float pp_g() { return max(u_gridSpacing, 1.0) * u_pxScale; }
ivec2 pp_grid() { return ivec2(ceil(u_box.zw / pp_g())); }
int pc_count() { ivec2 g = pp_grid(); return g.x * g.y * pp_per(); }
int pc_n(int id) { if (u_tpoly < 0.0) return 0; return id < pc_count() ? (u_object <= 1 ? 3 : 4) : 0; }
vec2 pc_vertex(int id, int k) {
  int cell = id / pp_per();
  ivec2 g = pp_grid();
  float s = pp_g();
  vec2 o = u_box.xy + vec2(float(cell % g.x), float(cell / g.x)) * s;
  if (u_object >= 2) return o + vec2(k == 1 || k == 2 ? s : 0.0, k >= 2 ? s : 0.0);
  if (id % 2 == 0) return k == 0 ? o : (k == 1 ? o + vec2(s, 0.0) : o + vec2(0.0, s));
  return k == 0 ? o + vec2(s, 0.0) : (k == 1 ? o + vec2(s, s) : o + vec2(0.0, s));
}
float pp_h(int i, uint k) { return fx_hashU(fx_pcg(uint(i) ^ uint(u_seedBits)) ^ k * 1664525u); }
void pc_place(int id, out vec2 c0, out mat3 R, out vec3 pos, out vec4 fc, out float alpha, out float extrude, out int mir) {
  int nv = u_object <= 1 ? 3 : 4;
  c0 = vec2(0.0);
  for (int k = 0; k < 4; k++) if (k < nv) c0 += pc_vertex(id, k);
  c0 /= float(nv);
  float t = u_tpoly;
  float sc = u_pxScale;
  vec2 L = u_box.zw / sc;
  float maxd = max(L.x, L.y);
  vec2 c = (c0 - u_box.xy) / sc;
  vec2 fcen = u_forceCenter * L;
  vec2 d = c - fcen;
  float dist = max(length(d), 1e-6);
  float ang = atan(d.y, d.x) + u_directionRandomness / 100.0 * 3.14159265 * (pp_h(id, 1u) * 2.0 - 1.0);
  float speed = u_force / 100.0 * 0.6 * maxd / (1.0 + dist / (0.5 * maxd)) * (1.0 + u_speedRandomness / 100.0 * (pp_h(id, 2u) * 2.0 - 1.0));
  float vz = -speed * 0.5 * pp_h(id, 3u);
  vec3 p = vec3(c.x + cos(ang) * speed * t, c.y + sin(ang) * speed * t + 0.25 * u_gravity * L.y * t * t, vz * t);
  vec3 axis = vec3(pp_h(id, 4u), pp_h(id, 5u), pp_h(id, 6u)) * 2.0 - 1.0;
  R = pc_rotAxis(axis, t * (3.14159265 * pp_h(id, 7u) + radians(u_spinning)));
  pos = vec3(u_box.xy + p.xy * sc, p.z * sc);
  alpha = 1.0;
  extrude = 0.0;
  mir = 0;
  fc = vec4(0.0);
  if (u_object == 0 || u_object == 2) {
    vec4 s = fx_unpremultiply(textureLod(u_source, c0 / u_canvasSize, 0.0));
    fc = s.a > 0.0 ? vec4(s.rgb, 1.0) : vec4(0.0);
    alpha = s.a;
  }
}
vec4 pc_front(vec2 t, int id) { return texture(u_source, t / u_canvasSize); }
vec4 pc_back(vec2 t, int id) { return texture(u_source, t / u_canvasSize); }
vec3 pc_sideColor(vec2 t, int id) { return vec3(0.0); }
`;

export const PIXEL_POLLY = defineShaderEffect({
	id: 'jasper.pixel-polly',
	label: 'Pixel Polly',
	category: SIM,
	description:
		'Breaks the layer into polygons or squares that fly apart from a force centre, spinning and falling.',
	keywords: ['shatter', 'explode', 'polygons', 'break', 'cc pixel polly'],
	params: [
		n('force', 'Force', 100, -1000, 1000, -300, 300, 0.1),
		n('gravity', 'Gravity', 1, -20, 20, -5, 5),
		fxParam.angle('spinning', 'Spinning', 0),
		fxParam.point('forceCenter', 'Force Center', [0.5, 0.5]),
		fxParam.percent('directionRandomness', 'Direction Randomness', 10),
		fxParam.percent('speedRandomness', 'Speed Randomness', 10),
		n('gridSpacing', 'Grid Spacing', 10, 1, 500, 2, 100, 1, { unit: 'px' }),
		popup('object', 'Object', POLLY_OBJECTS),
		fxParam.toggle('enableDepthSort', 'Enable Depth Sort', true),
		n('startTime', 'Start Time (sec)', 0, -1000, 1000, 0, 10, 0.01, { unit: 's' }),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		uniforms: (p, ctx) => {
			const t = ctx.frame / (ctx.fps > 0 ? ctx.fps : 30) - num(p.startTime);
			return {
				...pieceUniforms({}, ctx),
				u_tpoly: t > 0 ? t : -1,
				// Before Start Time the layer shows as it is.
				u_post: { int: t > 0 ? 5 : 7 },
				u_seedBits: { int: Math.floor(ctx.seed * 2147483647) },
			};
		},
		passes: (p, ctx) => {
			const g = Math.max(1, num(p.gridSpacing, 10)) * ctx.pxScale;
			const per = choice(p.object, values(POLLY_OBJECTS)) <= 1 ? 2 : 1;
			const count =
				Math.ceil((ctx.width * ctx.pxScale) / g) * Math.ceil((ctx.height * ctx.pxScale) / g) * per;
			const passes = piecePasses({ count, pieceGlsl: PIXEL_POLLY_GLSL });
			// Without depth sort the pieces draw in grid order: key = id.
			if (!bool(p.enableDepthSort, true))
				passes[0] = {
					...passes[0]!,
					frag: passes[0]!.frag.replace('return -pc_depth(pos);', 'return float(id);'),
				};
			return passes;
		},
	},
});

export const CARD_EFFECTS: readonly EffectSpec[] = [CARD_DANCE, PIXEL_POLLY];
export const CARD_TRANSITION_EFFECTS: readonly EffectSpec[] = [CARD_WIPE];

// Simulation ▸ Shatter (After Effects' Shatter): the layer breaks into pieces of a pattern
// (Bricks, Glass, Hexagons, Squares, Triangles, or a Custom Shatter Map whose colours group cells into pieces) where
// up to two force spheres reach it, optionally limited by a gradient; broken pieces fly with gravity, viscosity,
// mass variance and tumbling, extruded and textured (front, sides, back), through the camera and lights of pieces.ts.
// Wireframe views show the pattern (front or animated) and the forces. Every piece is a closed-form function of
// time. Ported from EffectCraft crates/effects/src/sim2.rs (pattern_cells, shatter_impl; MIT OR Apache-2.0), see
// licenses/ported/sim-warp.md.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_DATA } from '../glsl/data.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { fxParam } from '../params.ts';
import type { FxFrameContext, FxPixels } from '../shader.ts';
import { n, popup, randomSeedParam, values } from './common.ts';
import { choice, clamp, num, vec2 } from './core.ts';
import { cameraParams, lightingParams, materialParams, piecePasses, pieceUniforms } from './pieces.ts';

export const SHATTER_PATTERNS = ['Bricks', 'Glass', 'Hexagons', 'Squares', 'Triangles', 'Custom'] as const;
const VIEWS = [
	'Rendered',
	'Wireframe Front View',
	'Wireframe',
	'Wireframe Front View + Forces',
	'Wireframe + Forces',
] as const;
const RENDERS = ['All', 'Layer', 'Pieces'] as const;
const TUMBLE = ['Free', 'None', 'X', 'Y', 'Z', 'XY', 'XZ', 'YZ'] as const;
const TEXTURE_MODES = ['Color', 'Layer', 'Tinted Layer'] as const;
/** Most pieces Shatter cuts (larger patterns are refused by clamping Repetitions). */
const MAX_PIECES = 1 << 18;

/** The pattern lattice covering the layer: index ranges in pattern space and pieces per cell. */
export function shatterLattice(p: EffectParams, lw: number, lh: number) {
	const kind = choice(p.pattern, values(SHATTER_PATTERNS));
	const reps = clamp(num(p.repetitions, 10), 1, 500);
	const cell = lw / reps;
	const dir = (num(p.direction) * Math.PI) / 180;
	const o = vec2(p.origin, [0.5, 0.5]);
	const ox = o[0] * lw;
	const oy = o[1] * lh;
	const [sd, cd] = [Math.sin(dir), Math.cos(dir)];
	const corners = [
		[0, 0],
		[lw, 0],
		[lw, lh],
		[0, lh],
	].map(([x, y]) => [(x! - ox) * cd + (y! - oy) * sd, -(x! - ox) * sd + (y! - oy) * cd]);
	const px0 = Math.min(...corners.map((c) => c[0]!));
	const px1 = Math.max(...corners.map((c) => c[0]!));
	const py0 = Math.min(...corners.map((c) => c[1]!));
	const py1 = Math.max(...corners.map((c) => c[1]!));
	const k = kind === 5 ? 3 : kind;
	let ci0: number;
	let ci1: number;
	let cj0: number;
	let cj1: number;
	if (k === 0) {
		const bh = cell * 0.5;
		[ci0, ci1] = [Math.floor(px0 / cell) - 2, Math.ceil(px1 / cell) + 1];
		[cj0, cj1] = [Math.floor(py0 / bh) - 1, Math.ceil(py1 / bh) + 1];
	} else if (k === 2) {
		const r = cell / Math.sqrt(3);
		const dx = 1.5 * r;
		const dy = Math.sqrt(3) * r;
		[ci0, ci1] = [Math.floor(px0 / dx) - 1, Math.ceil(px1 / dx) + 1];
		[cj0, cj1] = [Math.floor(py0 / dy) - 1, Math.ceil(py1 / dy) + 1];
	} else {
		[ci0, ci1] = [Math.floor(px0 / cell) - 1, Math.ceil(px1 / cell) + 1];
		[cj0, cj1] = [Math.floor(py0 / cell) - 1, Math.ceil(py1 / cell) + 1];
	}
	const per = k === 1 || k === 4 ? 2 : 1;
	let ni = ci1 - ci0 + 1;
	let nj = cj1 - cj0 + 1;
	while (ni * nj * per > MAX_PIECES) {
		ni = Math.ceil(ni / 2);
		nj = Math.ceil(nj / 2);
	}
	return { kind, k, cell, dir, ox, oy, ci0, cj0, ni, nj, per, count: ni * nj * per };
}

/** A quantised colour key of the custom map (−1: transparent, no piece), 4 bits per channel. */
function mapKey(px: FxPixels, u: number, v: number): number {
	const x = clamp(Math.floor(u * px.width), 0, px.width - 1);
	const y = clamp(Math.floor(v * px.height), 0, px.height - 1);
	const i = (y * px.width + x) * 4;
	if (px.data[i + 3]! < 128) return -1;
	const q = (c: number) => Math.round((c / 255) * 15) & 15;
	return (q(px.data[i]!) << 8) | (q(px.data[i + 1]!) << 4) | q(px.data[i + 2]!);
}

/** Custom Shatter Map: per piece (group centre x, y in layer px, key, valid) — pieces of one colour break as one. */
function customGroups(
	_p: EffectParams,
	ctx: FxFrameContext,
	lat: ReturnType<typeof shatterLattice>,
): Float32Array | null {
	if (lat.kind !== 5) return null;
	const px = ctx.pixels?.('customShatterMap') ?? null;
	const lw = ctx.width;
	const lh = ctx.height;
	const [sd, cd] = [Math.sin(lat.dir), Math.cos(lat.dir)];
	const centre = (ci: number, cj: number) => {
		const u = (ci + 0.5) * lat.cell;
		const w = (cj + 0.5) * lat.cell;
		return [lat.ox + u * cd - w * sd, lat.oy + u * sd + w * cd] as const;
	};
	const keys = new Int32Array(lat.count);
	const sums = new Map<number, [number, number, number]>();
	for (let id = 0; id < lat.count; id++) {
		const c = Math.floor(id / lat.per);
		const [x, y] = centre(lat.ci0 + (c % lat.ni), lat.cj0 + Math.floor(c / lat.ni));
		const key = px ? mapKey(px, x / lw, y / lh) : id;
		keys[id] = key;
		if (key < 0) continue;
		const s = sums.get(key) ?? [0, 0, 0];
		s[0] += x;
		s[1] += y;
		s[2]++;
		sums.set(key, s);
	}
	const out = new Float32Array(lat.count * 4);
	for (let id = 0; id < lat.count; id++) {
		const key = keys[id]!;
		const s = key >= 0 ? sums.get(key) : undefined;
		out[id * 4] = s ? s[0] / s[2] : 0;
		out[id * 4 + 1] = s ? s[1] / s[2] : 0;
		out[id * 4 + 2] = key;
		out[id * 4 + 3] = s ? 1 : 0;
	}
	return out;
}

const SHATTER_GLSL = /* glsl */ `
float sh_h(int i, uint k) { return fx_hashU(fx_pcg(uint(i) ^ uint(u_seedBits)) ^ k * 1664525u); }
float sh_hs(int i, uint k) { return sh_h(i, k) * 2.0 - 1.0; }
// Pattern space → layer px.
vec2 sh_toLayer(vec2 q) { return u_shOrigin + vec2(q.x * u_shDir.y - q.y * u_shDir.x, q.x * u_shDir.x + q.y * u_shDir.y); }
float sh_jit(int i, int j, int k) { return fx_hashU(fx_pcg(uint(i * 7919 + j * 104729 + k) ^ uint(u_seedBits))) * 2.0 - 1.0; }
vec2 sh_glass(int i, int j) {
  return vec2(float(i) * u_shCell + sh_jit(i, j, 17) * u_shCell * 0.35, float(j) * u_shCell + sh_jit(i, j, 91) * u_shCell * 0.35);
}
int pc_count() { return u_shLat.z * u_shLat.w * u_shPer; }
// Pattern-space vertex k of piece id (n vertices in nOut).
vec2 sh_patternVertex(int id, int k, out int nOut) {
  int c = id / u_shPer;
  int sub = id - c * u_shPer;
  int ci = u_shLat.x + c % u_shLat.z;
  int cj = u_shLat.y + c / u_shLat.z;
  float cell = u_shCell;
  int kind = u_shKind;
  nOut = 4;
  if (kind == 0) {
    float bh = cell * 0.5;
    float sh = (cj % 2 + 2) % 2 == 1 ? cell * 0.5 : 0.0;
    vec2 o = vec2(float(ci) * cell + sh, float(cj) * bh);
    return o + vec2(k == 1 || k == 2 ? cell : 0.0, k >= 2 ? bh : 0.0);
  }
  if (kind == 2) {
    nOut = 6;
    float r = cell / sqrt(3.0);
    float cx = float(ci) * 1.5 * r;
    float cy = (float(cj) + ((ci % 2 + 2) % 2 == 1 ? 0.5 : 0.0)) * sqrt(3.0) * r;
    float a = float(k) * 1.0471976;
    return vec2(cx + r * cos(a), cy + r * sin(a));
  }
  if (kind == 1) {
    nOut = 3;
    vec2 p00 = sh_glass(ci, cj), p10 = sh_glass(ci + 1, cj), p11 = sh_glass(ci + 1, cj + 1), p01 = sh_glass(ci, cj + 1);
    bool diag = fx_hashU(fx_pcg(uint(ci * 31 + cj * 17) ^ uint(u_seedBits) ^ 0x55u)) < 0.5;
    if (diag) {
      if (sub == 0) return k == 0 ? p00 : (k == 1 ? p10 : p11);
      return k == 0 ? p00 : (k == 1 ? p11 : p01);
    }
    if (sub == 0) return k == 0 ? p00 : (k == 1 ? p10 : p01);
    return k == 0 ? p10 : (k == 1 ? p11 : p01);
  }
  if (kind == 4) {
    nOut = 3;
    vec2 o = vec2(float(ci), float(cj)) * cell;
    vec2 p00 = o, p10 = o + vec2(cell, 0.0), p11 = o + vec2(cell), p01 = o + vec2(0.0, cell);
    if ((ci + cj) % 2 == 0) {
      if (sub == 0) return k == 0 ? p00 : (k == 1 ? p10 : p01);
      return k == 0 ? p10 : (k == 1 ? p11 : p01);
    }
    if (sub == 0) return k == 0 ? p00 : (k == 1 ? p10 : p11);
    return k == 0 ? p00 : (k == 1 ? p11 : p01);
  }
  vec2 o = vec2(float(ci), float(cj)) * cell;
  return o + vec2(k == 1 || k == 2 ? cell : 0.0, k >= 2 ? cell : 0.0);
}
vec2 sh_layerVertex(int id, int k) { int nn; return sh_toLayer(sh_patternVertex(id, k, nn)); }
vec2 sh_centroid(int id, out int nv) {
  int nn;
  sh_patternVertex(id, 0, nn);
  nv = nn;
  vec2 s = vec2(0.0);
  for (int k = 0; k < 6; k++) if (k < nn) s += sh_layerVertex(id, k);
  return s / float(nn);
}
// Group (custom map): centre (layer px), key, valid.
vec4 sh_group(int id) {
  if (u_shKind != 5) { int nv; return vec4(sh_centroid(id, nv), float(id), 1.0); }
  return fx_texel(u_shGroups, id);
}
// Broken state and velocity (layer px / s) of a group at centre gc.
bool sh_broken(vec4 g, out vec3 v) {
  v = vec3(0.0);
  vec2 L = u_box.zw / u_pxScale;
  bool broken = false;
  for (int f = 0; f < 2; f++) {
    vec2 fp = (f == 0 ? u_force1Position : u_force2Position) * L;
    float rad = (f == 0 ? u_force1Radius : u_force2Radius) * L.x;
    if (rad <= 0.0) continue;
    vec3 dv = vec3(g.xy - fp, (f == 0 ? u_force1Depth : u_force2Depth) * L.x);
    float dist = length(dv);
    if (dist < rad) {
      broken = true;
      float k = (f == 0 ? u_force1Strength : u_force2Strength) * (1.0 - dist / rad) * L.x * 0.1 / max(dist, 1e-6);
      v += dv * k;
    }
  }
  if (broken && u_gradientLayer_size.x > 0.0) {
    vec4 c = fx_unpremultiply(textureLod(u_gradientLayer, g.xy / L, 0.0));
    float l = clamp(fx_luma(c.rgb), 0.0, 1.0);
    if (u_invertGradient) l = 1.0 - l;
    float thr = u_shatterThreshold / 100.0;
    broken = thr > 0.0 && l >= 1.0 - thr;
  }
  if (broken && u_shKind == 5 && u_whiteTilesFixed && int(g.z + 0.5) == 4095) broken = false;
  return broken;
}
int pc_n(int id) {
  if (id >= pc_count()) return 0;
  int nv;
  vec2 c = sh_centroid(id, nv);
  vec2 L = u_box.zw / u_pxScale;
  // Pieces wholly outside the layer: none.
  vec2 mn = vec2(1e9), mx = vec2(-1e9);
  for (int k = 0; k < 6; k++) if (k < nv) { vec2 q = sh_layerVertex(id, k); mn = min(mn, q); mx = max(mx, q); }
  if (mx.x < 0.0 || mx.y < 0.0 || mn.x > L.x || mn.y > L.y) return 0;
  vec4 g = sh_group(id);
  if (g.w < 0.5) return 0;
  if (u_wire == 0 || u_wire == 2 || u_wire == 4) {
    vec3 v;
    bool b = sh_broken(g, v);
    if ((b && u_render == 1) || (!b && u_render == 2)) return 0;
  }
  return nv;
}
vec2 pc_vertex(int id, int k) { return u_box.xy + sh_layerVertex(id, k) * u_pxScale; }
void sh_drag(float k, float t, out float f1, out float f2) {
  if (k < 1e-6) { f1 = t; f2 = 0.5 * t * t; return; }
  float e = exp(-k * t);
  f1 = (1.0 - e) / k;
  f2 = t / k - (1.0 - e) / (k * k);
}
void pc_place(int id, out vec2 c0, out mat3 R, out vec3 pos, out vec4 fc, out float alpha, out float extrude, out int mir) {
  int nv;
  vec2 pc = sh_centroid(id, nv);
  vec4 g = sh_group(id);
  float s = u_pxScale;
  vec2 L = u_box.zw / s;
  float unit = L.x * 0.1;
  c0 = u_box.xy + pc * s;
  R = mat3(1.0);
  vec3 gpos = vec3(g.xy, 0.0);
  vec3 v;
  bool broken = sh_broken(g, v);
  float t = max(u_time, 0.0);
  bool front = u_wire == 1 || u_wire == 3;
  bool moving = broken && t > 0.0 && !front;
  int key = int(g.z + 0.5);
  if (moving) {
    float mass = 1.0 + u_massVariance / 100.0 * sh_hs(key, 1u);
    v = v / mass + u_randomness * unit * 2.0 * vec3(sh_hs(key, 2u), sh_hs(key, 3u), sh_hs(key, 4u));
    float f1, f2;
    sh_drag(max(u_viscosity, 0.0) * 5.0, t, f1, f2);
    float gd = radians(u_gravityDirection), gi = radians(u_gravityInclination);
    vec3 g3 = vec3(sin(gd) * cos(gi), -cos(gd) * cos(gi), sin(gi)) * u_gravity * unit;
    gpos += v * f1 + g3 * f2;
    vec3 axis = vec3(sh_hs(key, 6u), sh_hs(key, 7u), sh_hs(key, 8u));
    if (u_tumbleAxis == 1) axis = vec3(0.0);
    else if (u_tumbleAxis == 2) axis = vec3(1.0, 0.0, 0.0);
    else if (u_tumbleAxis == 3) axis = vec3(0.0, 1.0, 0.0);
    else if (u_tumbleAxis == 4) axis = vec3(0.0, 0.0, 1.0);
    else if (u_tumbleAxis == 5) axis.z = 0.0;
    else if (u_tumbleAxis == 6) axis.y = 0.0;
    else if (u_tumbleAxis == 7) axis.x = 0.0;
    float speed = length(v) / unit;
    float omega = u_rotationSpeed * 6.2831853 * (0.5 + sh_h(key, 9u)) * min(speed, 10.0);
    R = pc_rotAxis(axis, omega * f1);
  }
  vec3 off = vec3(pc - g.xy, 0.0);
  vec3 wp = gpos + R * off;
  pos = vec3(u_box.xy + wp.xy * s, wp.z * s);
  alpha = clamp(u_opacity, 0.0, 1.0);
  extrude = moving ? max(u_extrusionDepth, 0.0) * u_shCell * s : 0.0;
  fc = vec4(0.0);
  mir = 0;
}
vec4 sh_face(int mode, highp sampler2D t, vec2 tsize, vec2 restPx) {
  if (mode == 0) return vec4(u_color.rgb, 1.0);
  vec4 c = tsize.x > 0.0 ? texture(t, (restPx - u_box.xy) / u_box.zw) : texture(u_source, restPx / u_canvasSize);
  if (mode == 2) c = vec4(c.rgb * u_color.rgb, c.a);
  return c;
}
vec4 pc_front(vec2 t, int id) { return sh_face(u_frontMode, u_frontLayer, u_frontLayer_size, t); }
vec4 pc_back(vec2 t, int id) { return sh_face(u_backMode, u_backLayer, u_backLayer_size, t); }
vec3 pc_sideColor(vec2 t, int id) { return fx_unpremultiply(sh_face(u_sideMode, u_sideLayer, u_sideLayer_size, t)).rgb; }
// Pieces cut from transparent areas of the front have no sides (the layer's alpha near the edge or at the centre).
float pc_sideAlpha(vec2 t, vec2 c0, int id) {
  vec2 near = mix(t, c0, 0.25);
  return max(pc_front(near, id).a, pc_front(c0, id).a);
}
`;

export const SHATTER = defineShaderEffect({
	id: 'jasper.shatter',
	label: 'Shatter',
	category: 'Simulation',
	description:
		'Explodes the layer into pieces of a pattern (bricks, glass, hexagons…, or a custom map) where force spheres reach it, with physics, extrusion, textures, camera and lights.',
	keywords: ['explode', 'break', 'glass', 'pieces', 'shards', 'debris'],
	params: [
		popup('view', 'View', VIEWS, 1),
		popup('render', 'Render', RENDERS, 0),
		popup('pattern', 'Pattern', SHATTER_PATTERNS, 0, 'Shape'),
		fxParam.media('customShatterMap', 'Custom Shatter Map', ['image'], { group: 'Shape' }),
		fxParam.toggle('whiteTilesFixed', 'White Tiles Fixed', false, { group: 'Shape' }),
		n('repetitions', 'Repetitions', 10, 1, 500, 1, 100, 0.01, { group: 'Shape' }),
		fxParam.angle('direction', 'Direction', 0, { group: 'Shape' }),
		fxParam.point('origin', 'Origin', [0.5, 0.5], { group: 'Shape' }),
		n('extrusionDepth', 'Extrusion Depth', 0.05, 0, 1, 0, 1, 0.001, { group: 'Shape' }),
		fxParam.point('force1Position', 'Position', [0.5, 0.5], { group: 'Force 1' }),
		n('force1Depth', 'Depth', 0.1, -1, 1, -1, 1, 0.001, { group: 'Force 1' }),
		n('force1Radius', 'Radius', 0.4, 0, 4, 0, 2, 0.001, { group: 'Force 1' }),
		n('force1Strength', 'Strength', 5, -20, 20, -10, 10, 0.01, { group: 'Force 1' }),
		fxParam.point('force2Position', 'Position', [0.25, 0.25], { group: 'Force 2' }),
		n('force2Depth', 'Depth', 0.1, -1, 1, -1, 1, 0.001, { group: 'Force 2' }),
		n('force2Radius', 'Radius', 0, 0, 4, 0, 2, 0.001, { group: 'Force 2' }),
		n('force2Strength', 'Strength', 5, -20, 20, -10, 10, 0.01, { group: 'Force 2' }),
		n('shatterThreshold', 'Shatter Threshold', 0, 0, 100, 0, 100, 0.1, { group: 'Gradient', unit: '%' }),
		fxParam.media('gradientLayer', 'Gradient Layer', ['image', 'video'], { group: 'Gradient' }),
		fxParam.toggle('invertGradient', 'Invert Gradient', false, { group: 'Gradient' }),
		n('rotationSpeed', 'Rotation Speed', 0.2, 0, 5, 0, 1, 0.001, { group: 'Physics' }),
		popup('tumbleAxis', 'Tumble Axis', TUMBLE, 0, 'Physics'),
		n('randomness', 'Randomness', 0.1, 0, 1, 0, 1, 0.001, { group: 'Physics' }),
		n('viscosity', 'Viscosity', 0.1, 0, 1, 0, 1, 0.001, { group: 'Physics' }),
		fxParam.percent('massVariance', 'Mass Variance', 30, { group: 'Physics' }),
		n('gravity', 'Gravity', 3, 0, 100, 0, 10, 0.01, { group: 'Physics' }),
		fxParam.angle('gravityDirection', 'Gravity Direction', 180, { group: 'Physics' }),
		n('gravityInclination', 'Gravity Inclination', 0, -90, 90, -90, 90, 0.1, { group: 'Physics' }),
		fxParam.color('color', 'Color', [1, 1, 1, 1], { group: 'Textures' }),
		n('opacity', 'Opacity', 1, 0, 1, 0, 1, 0.001, { group: 'Textures' }),
		popup('frontMode', 'Front Mode', TEXTURE_MODES, 1, 'Textures'),
		fxParam.media('frontLayer', 'Front Layer', ['image', 'video'], { group: 'Textures' }),
		popup('sideMode', 'Side Mode', TEXTURE_MODES, 0, 'Textures'),
		fxParam.media('sideLayer', 'Side Layer', ['image', 'video'], { group: 'Textures' }),
		popup('backMode', 'Back Mode', TEXTURE_MODES, 1, 'Textures'),
		fxParam.media('backLayer', 'Back Layer', ['image', 'video'], { group: 'Textures' }),
		...cameraParams(4),
		...lightingParams(1, 0.25),
		...materialParams(0.75),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		cpuPixels: ['customShatterMap'],
		uniforms: (p, ctx) => {
			const lat = shatterLattice(p, ctx.width, ctx.height);
			const groups = customGroups(p, ctx, lat);
			const view = choice(p.view, values(VIEWS));
			const rg = groups ?? new Float32Array(4);
			return {
				...pieceUniforms(p, ctx),
				u_shKind: { int: lat.kind },
				u_shCell: lat.cell,
				u_shDir: [Math.sin(lat.dir), Math.cos(lat.dir)],
				u_shOrigin: [lat.ox, lat.oy],
				u_shLat: { ivec4: [lat.ci0, lat.cj0, lat.ni, lat.nj] },
				u_shPer: { int: lat.per },
				u_shGroups: { texels: rg },
				u_wire: { int: view },
				u_post: { int: 5 },
				u_seedBits: { int: Math.floor(ctx.seed * 2147483647) },
			};
		},
		passes: (p, ctx) => {
			const lat = shatterLattice(p, ctx.width, ctx.height);
			const passes = piecePasses({
				count: lat.count,
				pieceGlsl: SHATTER_GLSL,
				include: [GLSL_COLOR, GLSL_DATA, GLSL_HASH],
				extrude: true,
				wire: true,
				post: false,
			});
			// Forces in the wireframe + forces views; the pieces only otherwise.
			passes.push({
				frag: /* glsl */ `
void main() {
  vec4 pcs = texture(u_pieces, v_uv);
  if (u_wire < 3) { fragColor = pcs; return; }
  vec2 L = u_box.zw / u_pxScale;
  vec2 q = fx_layerPx();
  float cov = 0.0;
  for (int f = 0; f < 2; f++) {
    vec2 fp = (f == 0 ? u_force1Position : u_force2Position) * L;
    float rad = (f == 0 ? u_force1Radius : u_force2Radius) * L.x;
    if (rad <= 0.0) continue;
    cov = max(cov, clamp(1.0 - abs(length(q - fp) - rad) * u_pxScale, 0.0, 1.0));
  }
  fragColor = vec4(vec3(1.0, 0.3, 0.3) * cov, cov) + pcs * (1.0 - cov);
}`,
			});
			return passes;
		},
	},
});

export const SHATTER_EFFECTS: readonly EffectSpec[] = [SHATTER];

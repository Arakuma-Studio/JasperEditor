// 3D pieces of the simulation-warp family (sim-warp workstream): Card Dance, Shatter, Card Wipe and Pixel Polly cut
// the layer into planar textured pieces (cards, shards, polygons) placed in 3D, seen through the effect's Camera
// System (Camera Position or Corner Pins) and lit by its Lighting / Material. Each effect defines its pieces in GLSL
// (a pure function of the piece id: rest polygon, rotation, position) so the same code runs in the sort-key pass and
// in the draw pass; pieces are drawn far to near after a GPU sort (sort.ts). Ported from EffectCraft
// crates/effects/src/card3d.rs (camera systems, lighting) and sim2.rs (Piece; MIT OR Apache-2.0), see
// licenses/ported/sim-warp.md.
import { type Mat3, multiplyMat3, type Quad, quadToQuad } from '../../../render/homography.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { fxParam } from '../params.ts';
import type { FxFrameContext, FxUniformValue, GlslChunk, ShaderPass } from '../shader.ts';
import { n, popup, values } from './common.ts';
import { bool, choice, clamp, num, rgba, vec2 } from './core.ts';
import { GLSL_SORTED, gpuSortPasses } from './sort.ts';
import { GLSL_SPRITES } from './sprites.ts';

export const CAMERA_SYSTEMS = ['Camera Position', 'Corner Pins'] as const;
export const TRANSFORM_ORDERS = [
	'Rotate XYZ, Position',
	'Rotate XZY, Position',
	'Rotate YXZ, Position',
	'Rotate YZX, Position',
	'Rotate ZXY, Position',
	'Rotate ZYX, Position',
	'Position, Rotate XYZ',
	'Position, Rotate XZY',
	'Position, Rotate YXZ',
	'Position, Rotate YZX',
	'Position, Rotate ZXY',
	'Position, Rotate ZYX',
] as const;
export const LIGHT_TYPES = ['Distant Source', 'Point Source'] as const;

/** Camera System, Camera Position and Corner Pins params (`z` = default Z Position, in layer sizes). */
export function cameraParams(z: number): ParamSpec[] {
	const c = 'Camera Position';
	const k = 'Corner Pins';
	return [
		popup('cameraSystem', 'Camera System', CAMERA_SYSTEMS, 0),
		fxParam.angle('cameraXRotation', 'X Rotation', 0, { group: c }),
		fxParam.angle('cameraYRotation', 'Y Rotation', 0, { group: c }),
		fxParam.angle('cameraZRotation', 'Z Rotation', 0, { group: c }),
		fxParam.point('cameraXYPosition', 'X, Y Position', [0.5, 0.5], { group: c }),
		n('cameraZPosition', 'Z Position', z, 0.05, 10, 0.5, 5, 0.01, { group: c }),
		n('focalLength', 'Focal Length', 70, 1, 500, 10, 200, 0.1, { group: c }),
		popup('transformOrder', 'Transform Order', TRANSFORM_ORDERS, 0, c),
		fxParam.point('upperLeftCorner', 'Upper Left Corner', [0, 0], { group: k }),
		fxParam.point('upperRightCorner', 'Upper Right Corner', [1, 0], { group: k }),
		fxParam.point('lowerLeftCorner', 'Lower Left Corner', [0, 1], { group: k }),
		fxParam.point('lowerRightCorner', 'Lower Right Corner', [1, 1], { group: k }),
		fxParam.toggle('autoFocalLength', 'Auto Focal Length', true, { group: k }),
		n('pinsFocalLength', 'Focal Length', 70, 1, 500, 10, 200, 0.1, { group: k }),
	];
}

export function lightingParams(intensity: number, ambient: number): ParamSpec[] {
	const g = 'Lighting';
	return [
		popup('lightType', 'Light Type', LIGHT_TYPES, 0, g),
		n('lightIntensity', 'Light Intensity', intensity, 0, 4, 0, 2, 0.01, { group: g }),
		fxParam.color('lightColor', 'Light Color', [1, 1, 1, 1], { group: g }),
		fxParam.point('lightPosition', 'Light Position', [0.5, 0.5], { group: g }),
		n('lightDepth', 'Light Depth', 1, -10, 10, 0, 5, 0.001, { group: g }),
		n('ambientLight', 'Ambient Light', ambient, 0, 2, 0, 1, 0.01, { group: g }),
	];
}

/** Material (Specular 0 by default so pieces at rest reproduce the layer). */
export function materialParams(diffuse: number): ParamSpec[] {
	const g = 'Material';
	return [
		n('diffuseReflection', 'Diffuse Reflection', diffuse, 0, 2, 0, 1, 0.01, { group: g }),
		n('specularReflection', 'Specular Reflection', 0, 0, 2, 0, 1, 0.01, { group: g }),
		n('highlightSharpness', 'Highlight Sharpness', 15, 1, 100, 1, 100, 0.1, { group: g }),
	];
}

type M3 = number[][];
const mul = (a: M3, b: M3): M3 =>
	a.map((r) => [0, 1, 2].map((j) => r[0]! * b[0]![j]! + r[1]! * b[1]![j]! + r[2]! * b[2]![j]!));
const rx = (a: number): M3 => [
	[1, 0, 0],
	[0, Math.cos(a), -Math.sin(a)],
	[0, Math.sin(a), Math.cos(a)],
];
const ry = (a: number): M3 => [
	[Math.cos(a), 0, Math.sin(a)],
	[0, 1, 0],
	[-Math.sin(a), 0, Math.cos(a)],
];
const rz = (a: number): M3 => [
	[Math.cos(a), -Math.sin(a), 0],
	[Math.sin(a), Math.cos(a), 0],
	[0, 0, 1],
];
const rad = (d: number) => (d * Math.PI) / 180;

/** Rotation applying the axes in `order` (0 XYZ … 5 ZYX; the first letter is applied first). */
export function rotOrdered(x: number, y: number, z: number, order: number): M3 {
	const [mx, my, mz] = [rx(x), ry(y), rz(z)];
	const seq = [
		[mx, my, mz],
		[mx, mz, my],
		[my, mx, mz],
		[my, mz, mx],
		[mz, mx, my],
		[mz, my, mx],
	][order % 6]!;
	return mul(seq[2]!, mul(seq[1]!, seq[0]!));
}

/** A camera: canvas-world (x, y canvas px, z px away) → canvas px, homogeneous rows X, Y, W (3 × 4). */
export type Proj = { m: number[][]; near: number };

function simpleProj(c: [number, number], d: number): Proj {
	return {
		m: [
			[d, 0, c[0], 0],
			[0, d, c[1], 0],
			[0, 0, 1, d],
		],
		near: 0.05 * d,
	};
}

function after(p: Proj, a: M3, t: number[]): Proj {
	const m = [0, 1, 2].map((i) => [
		...[0, 1, 2].map((j) => p.m[i]![0]! * a[0]![j]! + p.m[i]![1]! * a[1]![j]! + p.m[i]![2]! * a[2]![j]!),
		p.m[i]![0]! * t[0]! + p.m[i]![1]! * t[1]! + p.m[i]![2]! * t[2]! + p.m[i]![3]!,
	]);
	return { m, near: p.near };
}

function then(p: Proj, h: Mat3): Proj {
	const H = [
		[h[0], h[1], h[2]],
		[h[3], h[4], h[5]],
		[h[6], h[7], h[8]],
	];
	const m = [0, 1, 2].map((i) =>
		[0, 1, 2, 3].map((j) => H[i]![0]! * p.m[0]![j]! + H[i]![1]! * p.m[1]![j]! + H[i]![2]! * p.m[2]![j]!),
	);
	return { m, near: p.near * Math.max(Math.abs(h[8]), 1e-9) };
}

/** The camera of a piece effect (box: the layer box in canvas px). */
export function projection(p: EffectParams, box: { x: number; y: number; w: number; h: number }): Proj {
	const c: [number, number] = [box.x + box.w / 2, box.y + box.h / 2];
	const size = Math.max(box.w, box.h);
	const at = (v: unknown, d: [number, number]): [number, number] => {
		const q = vec2(v, d);
		return [box.x + q[0] * box.w, box.y + q[1] * box.h];
	};
	if (choice(p.cameraSystem, values(CAMERA_SYSTEMS)) === 1) {
		const focal = bool(p.autoFocalLength, true) ? 70 : Math.max(1, num(p.pinsFocalLength, 70));
		const base = simpleProj(c, (size * 2 * focal) / 70);
		const quad: Quad = [
			at(p.upperLeftCorner, [0, 0]),
			at(p.upperRightCorner, [1, 0]),
			at(p.lowerRightCorner, [1, 1]),
			at(p.lowerLeftCorner, [0, 1]),
		];
		const rect: Quad = [
			[box.x, box.y],
			[box.x + box.w, box.y],
			[box.x + box.w, box.y + box.h],
			[box.x, box.y + box.h],
		];
		const hm = quadToQuad(rect, quad);
		return hm ? then(base, hm) : base;
	}
	const zpos = Math.max(0.05, num(p.cameraZPosition, 2));
	const focal = Math.max(1, num(p.focalLength, 70));
	const base = simpleProj(c, (size * zpos * focal) / 140);
	const order = choice(p.transformOrder, values(TRANSFORM_ORDERS));
	const r = rotOrdered(
		rad(num(p.cameraXRotation)),
		rad(num(p.cameraYRotation)),
		rad(num(p.cameraZRotation)),
		order,
	);
	const xy = at(p.cameraXYPosition, [0.5, 0.5]);
	const shift = [xy[0] - c[0], xy[1] - c[1], 0];
	const c3 = [c[0], c[1], 0];
	const rc = [0, 1, 2].map((i) => c3[i]! - (r[i]![0]! * c3[0]! + r[i]![1]! * c3[1]!));
	const t =
		order >= 6
			? [0, 1, 2].map((i) => rc[i]! + r[i]![0]! * shift[0]! + r[i]![1]! * shift[1]!)
			: [0, 1, 2].map((i) => rc[i]! + shift[i]!);
	return after(base, r, t);
}

/** Camera centre (where the projection collapses) in canvas-world, or far in front without one. */
export function eyeOf(p: Proj): [number, number, number] {
	const a: Mat3 = [
		p.m[0]![0]!,
		p.m[0]![1]!,
		p.m[0]![2]!,
		p.m[1]![0]!,
		p.m[1]![1]!,
		p.m[1]![2]!,
		p.m[2]![0]!,
		p.m[2]![1]!,
		p.m[2]![2]!,
	];
	const det =
		a[0] * (a[4] * a[8] - a[5] * a[7]) -
		a[1] * (a[3] * a[8] - a[5] * a[6]) +
		a[2] * (a[3] * a[7] - a[4] * a[6]);
	if (Math.abs(det) < 1e-12) return [0, 0, -1e9];
	// Solve A e = −t by Cramer's rule.
	const b = [-p.m[0]![3]!, -p.m[1]![3]!, -p.m[2]![3]!];
	const col = (k: number) => {
		const m = [...a];
		m[k] = b[0]!;
		m[3 + k] = b[1]!;
		m[6 + k] = b[2]!;
		return (
			m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
			m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
			m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
		);
	};
	return [col(0) / det, col(1) / det, col(2) / det];
}

/** Camera and lighting uniforms of a piece effect. */
export function pieceUniforms(p: EffectParams, ctx: FxFrameContext): Record<string, FxUniformValue> {
	const s = ctx.pxScale;
	// The pieces' layer box inside the canvas (piece effects have no padding: the box is the canvas).
	const box = { x: 0, y: 0, w: ctx.width * s, h: ctx.height * s };
	const proj = projection(p, box);
	const eye = eyeOf(proj);
	const intensity = num(p.lightIntensity, 1);
	const lc = rgba(p.lightColor, [1, 1, 1, 1]);
	const lp = vec2(p.lightPosition, [0.5, 0.5]);
	const lpos = [box.x + lp[0] * box.w, box.y + lp[1] * box.h, -num(p.lightDepth, 1) * Math.max(box.w, box.h)];
	const centre = [box.w / 2, box.h / 2, 0];
	const tl = [lpos[0]! - centre[0]!, lpos[1]! - centre[1]!, lpos[2]! - centre[2]!];
	const tll = Math.hypot(tl[0]!, tl[1]!, tl[2]!) || 1;
	return {
		u_cam0: proj.m[0] as [number, number, number, number],
		u_cam1: proj.m[1] as [number, number, number, number],
		u_cam2: proj.m[2] as [number, number, number, number],
		u_near: proj.near,
		u_eye: eye,
		u_lkind: { int: choice(p.lightType, values(LIGHT_TYPES)) },
		u_lcolor: [lc[0] * intensity, lc[1] * intensity, lc[2] * intensity],
		u_lpos: lpos as [number, number, number],
		u_ldir: [tl[0]! / tll, tl[1]! / tll, tl[2]! / tll],
		u_amb: num(p.ambientLight, 0.25),
		u_kd: num(p.diffuseReflection, 0.75),
		u_ks: num(p.specularReflection, 0),
		u_sharp: Math.max(1, num(p.highlightSharpness, 15)),
	};
}

/** Camera projection, lighting and the piece helpers (both stages). */
export const GLSL_PIECES: GlslChunk = {
	name: 'sim/pieces',
	deps: [GLSL_SPRITES],
	source: /* glsl */ `
// Canvas-world point → (canvas px x, y, W).
vec3 pc_project(vec3 q) {
  vec4 h = vec4(q, 1.0);
  return vec3(dot(u_cam0, h), dot(u_cam1, h), dot(u_cam2, h));
}
float pc_depth(vec3 q) { return dot(u_cam2, vec4(q, 1.0)); }
// Rotation about a unit axis (Rodrigues), column-major mat3 of the rotation matrix.
mat3 pc_rotAxis(vec3 a, float ang) {
  float l = length(a);
  if (l < 1e-9 || ang == 0.0) return mat3(1.0);
  a /= l;
  float s = sin(ang), c = cos(ang), t = 1.0 - c;
  return mat3(t * a.x * a.x + c, t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y,
              t * a.x * a.y - s * a.z, t * a.y * a.y + c, t * a.y * a.z + s * a.x,
              t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c);
}
mat3 pc_rx(float a) { return mat3(1.0, 0.0, 0.0, 0.0, cos(a), sin(a), 0.0, -sin(a), cos(a)); }
mat3 pc_ry(float a) { return mat3(cos(a), 0.0, -sin(a), 0.0, 1.0, 0.0, sin(a), 0.0, cos(a)); }
mat3 pc_rz(float a) { return mat3(cos(a), sin(a), 0.0, -sin(a), cos(a), 0.0, 0.0, 0.0, 1.0); }
// Lighting: (tint, specular) of a surface with normal n at q (both sides lit, as in After Effects' card effects).
void pc_shade(vec3 n, vec3 q, out vec3 tint, out vec3 spec) {
  vec3 v = normalize(u_eye - q);
  if (dot(n, v) < 0.0) n = -n;
  vec3 l = u_lkind == 1 ? normalize(u_lpos - q) : u_ldir;
  float ndl = max(dot(n, l), 0.0);
  vec3 h = normalize(l + v);
  float sp = (u_ks > 0.0 && ndl > 0.0) ? u_ks * pow(max(dot(n, h), 0.0), u_sharp) : 0.0;
  tint = vec3(u_amb) + u_kd * ndl * u_lcolor;
  spec = sp * u_lcolor;
}
`,
};

/**
 * The passes of a piece effect. The author's GLSL (`pieceGlsl`, included in every pass) defines:
 * - `int pc_count()` — number of pieces (uniform-driven), `int pc_n(int id)` — vertices of piece id (3…6, 0 = none);
 * - `vec2 pc_vertex(int id, int k)` — rest vertex k (canvas px, convex, any winding);
 * - `void pc_place(int id, out vec2 c0, out mat3 R, out vec3 pos, out vec4 flatCol, out float alpha, out float extrude,
 *   out int mirror)` — rest centre c0, rotation R, centre position pos (canvas px, z px away), a flat colour
 *   (flatCol.a > 0 = draw it instead of the texture), opacity, extrusion depth (px, 0 = flat) and the back face's
 *   texture mirroring (0 none, 1 about the X axis, 2 about the Y axis);
 * - `vec4 pc_front(vec2 restPx, int id)`, `vec4 pc_back(vec2 restPx, int id)` — premultiplied texture of each face
 *   (return vec4(-1) from pc_back to drop back-facing pieces); `vec3 pc_sideColor(vec2 restPx, int id)`;
 * - `float pc_sideAlpha(vec2 restPx, vec2 restCentre, int id)` — 0 drops the side faces of a piece (pieces cut from
 *   transparent areas of the layer have no visible sides).
 * The last pass composites the pieces with the original by `u_post` (sp_combine; 5 = pieces only).
 */
export function piecePasses(opts: {
	count: number;
	pieceGlsl: string;
	include?: ShaderPass['include'];
	extrude?: boolean;
	post?: boolean;
	/** Wireframe views: `u_wire` (int, uniform of the effect) > 0 draws the piece outlines instead of the faces. */
	wire?: boolean;
}): ShaderPass[] {
	const include = [GLSL_PIECES, ...(opts.include ?? [])];
	const vertices = opts.extrude ? 12 + 36 : 12;
	return [
		...gpuSortPasses({
			count: opts.count,
			include,
			keyGlsl: /* glsl */ `${opts.pieceGlsl}
float sw_sortKey(int id) {
  if (pc_n(id) < 3) return 3.0e38;
  vec2 c0; mat3 R; vec3 pos; vec4 fc; float al; float ex; int mir;
  pc_place(id, c0, R, pos, fc, al, ex, mir);
  return -pc_depth(pos);
}`,
		}),
		{
			output: 'pieces',
			include: [...include, GLSL_SORTED],
			draw: {
				vertices,
				instances: Math.max(0, Math.floor(opts.count)),
				vert: /* glsl */ `${opts.pieceGlsl}
out vec2 v_tex;
flat out vec4 v_tint;   // tint rgb, alpha
flat out vec4 v_spec;   // spec rgb, face (0 front, 1 back, 2 side)
flat out vec4 v_flat;
flat out ivec2 v_idm;   // id, mirror
flat out vec2 v_c0;
void main() {
  int id = sw_sortedId(gl_InstanceID);
  int v = gl_VertexID;
  int nv = pc_n(id);
  v_tex = vec2(0.0); v_tint = vec4(0.0); v_spec = vec4(0.0); v_flat = vec4(0.0); v_idm = ivec2(0); v_c0 = vec2(0.0);
  if (nv < 3) { fx_cull(); return; }
  vec2 c0; mat3 R; vec3 pos; vec4 fc; float alpha; float extrude; int mir;
  pc_place(id, c0, R, pos, fc, alpha, extrude, mir);
  vec3 nrm = R * vec3(0.0, 0.0, -1.0);
  vec3 tint; vec3 spec;
  vec3 wq;
  int face;
  if (v < 12) {
    int t = v / 3;
    if (t + 2 >= nv) { fx_cull(); return; }
    int k = v % 3;
    int vi = k == 0 ? 0 : t + k;
    vec2 rv = pc_vertex(id, vi);
    v_tex = rv;
    wq = pos + R * vec3(rv - c0, 0.0);
    bool facing = dot(nrm, u_eye - pos) > 0.0;
    face = facing ? 0 : 1;
    pc_shade(nrm, pos, tint, spec);
  } else {
    // Extrusion sides: edge e as a quad from the front outline back by the depth.
    if (extrude <= 0.0) { fx_cull(); return; }
    int e = (v - 12) / 6;
    if (e >= nv) { fx_cull(); return; }
    int q = (v - 12) % 6;
    int qi = q < 3 ? q : (q == 3 ? 2 : (q == 4 ? 1 : 3));
    vec2 a = pc_vertex(id, e);
    vec2 b = pc_vertex(id, (e + 1) % nv);
    vec2 rv = (qi == 1 || qi == 3) ? b : a;
    float back = qi >= 2 ? 1.0 : 0.0;
    v_tex = (a + b) * 0.5;
    vec3 nb = -nrm;
    wq = pos + R * vec3(rv - c0, 0.0) + nb * extrude * back;
    vec3 ew = normalize(R * vec3(b - a, 0.0));
    vec3 sn = normalize(cross(ew, nb));
    vec3 mid = pos + R * vec3((a + b) * 0.5 - c0, 0.0) + nb * extrude * 0.5;
    if (dot(sn, mid - pos) < 0.0) sn = -sn;
    if (dot(sn, u_eye - mid) <= 0.0) { fx_cull(); return; }
    if (pc_sideAlpha(v_tex, c0, id) < 0.004) { fx_cull(); return; }
    face = 2;
    pc_shade(sn, mid, tint, spec);
  }
  vec3 pr = pc_project(wq);
  if (pr.z < u_near) { fx_cull(); return; }
  v_tint = vec4(tint, alpha);
  v_spec = vec4(spec, float(face));
  v_flat = face == 2 ? vec4(pc_sideColor(v_tex, id), 1.0) : fc;
  v_idm = ivec2(id, mir);
  v_c0 = c0;
  fx_emitW(pr.xy / pr.z, pr.z);
}`,
			},
			frag: /* glsl */ `${opts.pieceGlsl}
in vec2 v_tex;
flat in vec4 v_tint;
flat in vec4 v_spec;
flat in vec4 v_flat;
flat in ivec2 v_idm;
flat in vec2 v_c0;
void main() {
  int face = int(v_spec.w + 0.5);
${
	opts.wire
		? `  if (u_wire > 0) {
    // Outline: distance (rest px) to the polygon's edges.
    if (face == 2) { fragColor = vec4(0.0); return; }
    int nv = pc_n(v_idm.x);
    float dmin = 1e9;
    for (int k = 0; k < 6; k++) {
      if (k >= nv) break;
      vec2 a = pc_vertex(v_idm.x, k);
      vec2 b = pc_vertex(v_idm.x, (k + 1) % nv);
      vec2 ab = b - a;
      float t = clamp(dot(v_tex - a, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
      dmin = min(dmin, length(v_tex - a - ab * t));
    }
    float cov = clamp(1.0 - dmin / max(u_pxScale, 0.5), 0.0, 1.0);
    fragColor = vec4(vec3(0.75, 0.85, 1.0) * cov, cov);
    return;
  }`
		: ''
}
  vec4 c;
  if (v_flat.a > 0.0) c = vec4(v_flat.rgb, 1.0);
  else {
    vec2 t = v_tex;
    if (face == 1 && v_idm.y == 1) t.y = 2.0 * v_c0.y - t.y;
    if (face == 1 && v_idm.y == 2) t.x = 2.0 * v_c0.x - t.x;
    vec4 tx = face == 1 ? pc_back(t, v_idm.x) : pc_front(t, v_idm.x);
    if (tx.a < 0.0) { fragColor = vec4(0.0); return; }
    c = fx_unpremultiply(tx);
  }
  float a = c.a * v_tint.a;
  fragColor = vec4((c.rgb * v_tint.rgb + v_spec.rgb) * a, a);
}`,
		},
		...(opts.post === false
			? []
			: [
					{
						include: [GLSL_SPRITES],
						frag: /* glsl */ `
void main() { fragColor = sp_combine(u_post, texture(u_source, v_uv), texture(u_pieces, v_uv)); }`,
					},
				]),
	];
}

/** Clamped integer of a param. */
export const intOf = (v: unknown, d: number, lo: number, hi: number) => clamp(Math.round(num(v, d)), lo, hi);
export { multiplyMat3 };

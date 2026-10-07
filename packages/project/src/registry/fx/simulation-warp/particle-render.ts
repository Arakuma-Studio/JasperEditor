// Particle rendering of Particle World and Particle Systems II (sim-warp workstream): one instanced draw pass reads a
// record per particle (sorted far to near in TS) and draws its Particle Type — sprite shapes (sp_shade), 3D polygons
// and solids (Tripolygon, QuadPolygon, Cube, Tetrahedron: rotated in the vertex shader, back faces culled, lit),
// textured discs / squares / quads (the Texture Layer), and lenses that refract the layer under them.

import { GLSL_DATA } from '../glsl/data.ts';
import type { GlslChunk } from '../shader.ts';
import { GLSL_SPRITES } from './sprites.ts';

/** Particle Types (Particle World; Particle Systems II uses the same list). */
export const PARTICLE_TYPES = [
	'Line',
	'Shaded Sphere',
	'Faded Sphere',
	'Darkened Sphere',
	'Bubble',
	'Star',
	'Tripolygon',
	'QuadPolygon',
	'Motion Polygon',
	'Cube',
	'Tetrahedron',
	'Textured Disc',
	'Textured Square',
	'Textured QuadPolygon',
	'Lens Convex',
	'Lens Concave',
	'Lens Fade Sphere',
	'Lens Darken Sphere',
	'Lens Bubble',
] as const;

/** Render kind per type: 0 sprite shape, 1 3D polygon/solid, 2 textured, 3 lens. */
export const TYPE_KIND = [0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 2, 2, 2, 3, 3, 3, 3, 3];
/** sp_shade shape per sprite type (and the guide lines: 8). */
export const TYPE_SHAPE = [8, 2, 3, 9, 4, 5, 7, 6, 8, 6, 7, 1, 6, 6, 1, 1, 1, 1, 1];
/** Vertices per instance of a type. */
export const typeVertices = (type: number) => (type === 9 ? 36 : type === 10 ? 12 : 6);

/** Texels per particle record. */
export const REC = 4;

/**
 * Writes one record. Positions/sizes in canvas px. `kind`: TYPE_KIND or 0 for guides; `ptype`: Particle Type index.
 * t0 (x, y, r, rot) · t1 (straight rgba) · t2 (shape, segX, segY, rnd) · t3 (kind, ptype, scatterU, scatterV).
 */
export function writeRecord(
	out: Float32Array,
	i: number,
	x: number,
	y: number,
	r: number,
	rot: number,
	c: readonly number[],
	shape: number,
	seg: readonly [number, number],
	rnd: number,
	kind: number,
	ptype: number,
	scatter: readonly [number, number],
): void {
	const o = i * REC * 4;
	out[o] = x;
	out[o + 1] = y;
	out[o + 2] = r;
	out[o + 3] = rot;
	out[o + 4] = c[0]!;
	out[o + 5] = c[1]!;
	out[o + 6] = c[2]!;
	out[o + 7] = c[3]!;
	out[o + 8] = shape;
	out[o + 9] = seg[0];
	out[o + 10] = seg[1];
	out[o + 11] = rnd;
	out[o + 12] = kind;
	out[o + 13] = ptype;
	out[o + 14] = scatter[0];
	out[o + 15] = scatter[1];
}

/** GLSL of the particle draw pass (vertex + fragment parts share it). Needs `u_parts` (texels) and `u_texture`. */
export const GLSL_PARTICLES: GlslChunk = {
	name: 'sim/particles',
	deps: [GLSL_SPRITES, GLSL_DATA],
	source: /* glsl */ `
// Rotation matrix about a unit axis.
mat3 pw_rotAxis(vec3 a, float ang) {
  float s = sin(ang), c = cos(ang), t = 1.0 - c;
  return mat3(t * a.x * a.x + c, t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y,
              t * a.x * a.y - s * a.z, t * a.y * a.y + c, t * a.y * a.z + s * a.x,
              t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c);
}
// Corner c (0..7) of the unit cube (±1).
vec3 pw_cubeCorner(int c) { return vec3((c & 1) == 1 ? 1.0 : -1.0, (c & 2) == 2 ? 1.0 : -1.0, (c & 4) == 4 ? 1.0 : -1.0); }
// Vertex v (0..35) of a cube: 6 faces × 2 triangles; returns the corner position, face normal in n.
vec3 pw_cubeVertex(int v, out vec3 n) {
  int f = v / 6;
  int k = v % 6;
  int ax = f / 2;
  float sg = (f % 2) == 0 ? -1.0 : 1.0;
  n = vec3(ax == 0 ? sg : 0.0, ax == 1 ? sg : 0.0, ax == 2 ? sg : 0.0);
  // The face's corner square in (u, w) of the other two axes.
  int qi = k < 3 ? k : (k == 3 ? 2 : (k == 4 ? 1 : 3));
  float u = (qi == 1 || qi == 3) ? 1.0 : -1.0;
  float w = qi >= 2 ? 1.0 : -1.0;
  if (sg < 0.0) u = -u; // keep the winding outward-facing
  if (ax == 0) return vec3(sg, u, w);
  if (ax == 1) return vec3(w, sg, u);
  return vec3(u, w, sg);
}
// Vertex v (0..11) of a regular tetrahedron (circumradius 1); face normal in n.
vec3 pw_tetraVertex(int v, out vec3 n) {
  vec3 p0 = vec3(1.0, 1.0, 1.0) * 0.57735;
  vec3 p1 = vec3(1.0, -1.0, -1.0) * 0.57735;
  vec3 p2 = vec3(-1.0, 1.0, -1.0) * 0.57735;
  vec3 p3 = vec3(-1.0, -1.0, 1.0) * 0.57735;
  int f = v / 3;
  int k = v % 3;
  vec3 a = f == 0 ? p1 : p0;
  vec3 b = f == 0 ? p2 : (f == 1 ? p2 : (f == 2 ? p3 : p1));
  vec3 c = f == 0 ? p3 : (f == 1 ? p1 : (f == 2 ? p2 : p3));
  n = normalize(cross(b - a, c - a));
  if (dot(n, a) < 0.0) { n = -n; vec3 t = b; b = c; c = t; }
  return k == 0 ? a : (k == 1 ? b : c);
}
`,
};

export const PARTICLE_VERT = /* glsl */ `
out vec2 v_d;
out vec2 v_seg;
out vec2 v_tuv;
flat out int v_shape;
flat out int v_kind;
flat out vec4 v_col;
flat out vec4 v_rr; // r, rot, lens type, unused
flat out vec2 v_ctr;
void main() {
  int i = gl_InstanceID;
  int v = gl_VertexID;
  vec4 t0 = fx_texel(u_parts, i * 4);
  vec4 col = fx_texel(u_parts, i * 4 + 1);
  vec4 t2 = fx_texel(u_parts, i * 4 + 2);
  vec4 t3 = fx_texel(u_parts, i * 4 + 3);
  int kind = int(t3.x + 0.5);
  int ptype = int(t3.y + 0.5);
  vec2 p = t0.xy;
  float r = t0.z;
  v_shape = int(t2.x + 0.5);
  v_kind = kind;
  v_col = col;
  v_rr = vec4(r, t0.w, float(ptype), 0.0);
  v_ctr = p;
  v_seg = t2.yz;
  v_tuv = vec2(0.0);
  v_d = vec2(0.0);
  if (col.a <= 1e-5 || r <= 0.0) { fx_cull(); return; }
  if (kind == 1 || ptype == 13) {
    // 3D polygons and solids: rotated about a per-particle axis, lit from the upper left.
    vec3 axis = normalize(vec3(sp_hs(int(t2.w * 65536.0), 1, 77u), sp_hs(int(t2.w * 65536.0), 2, 77u), sp_hs(int(t2.w * 65536.0), 3, 77u)) + vec3(1e-4));
    mat3 R = pw_rotAxis(axis, t0.w);
    vec3 n = vec3(0.0, 0.0, -1.0);
    vec3 q;
    if (ptype == 9) q = pw_cubeVertex(v, n) * 0.6;
    else if (ptype == 10) q = pw_tetraVertex(v, n);
    else if (ptype == 6) {
      if (v >= 3) { fx_cull(); return; }
      float a = 1.5707963 + float(v) * 2.0943951;
      q = vec3(cos(a), sin(a), 0.0);
    } else {
      vec2 c = sp_corner(v);
      q = vec3(c * 0.75, 0.0);
      v_tuv = c * 0.5 + 0.5;
    }
    vec3 rn = R * n;
    bool solid = ptype == 9 || ptype == 10;
    if (solid && rn.z > 0.0) { fx_cull(); return; }
    float lit = 0.25 + 0.75 * abs(dot(normalize(rn), normalize(vec3(-0.45, -0.55, -0.7))));
    v_col = vec4(col.rgb * lit, col.a);
    vec3 rq = R * q * r;
    v_d = rq.xy;
    fx_emit(p + rq.xy);
    return;
  }
  if (v >= 6) { fx_cull(); return; }
  vec2 corner = sp_corner(v);
  vec2 qq = v_shape == 8 ? sp_lineCorner(corner, p, t2.yz, r) : p + corner * sp_extent(v_shape, r);
  v_d = qq - p;
  v_tuv = t3.zw;
  fx_emit(qq);
}
`;

export const PARTICLE_FRAG = /* glsl */ `
in vec2 v_d;
in vec2 v_seg;
in vec2 v_tuv;
flat in int v_shape;
flat in int v_kind;
flat in vec4 v_col;
flat in vec4 v_rr;
flat in vec2 v_ctr;
void main() {
  int ptype = int(v_rr.z + 0.5);
  if (v_kind == 1 || ptype == 13) {
    vec4 c = v_col;
    if (ptype == 13) {
      vec4 tx = u_texture_size.x > 0.0 ? texture(u_texture, fract(v_tuv)) : vec4(1.0);
      c = vec4(fx_unpremultiply(tx).rgb * c.rgb, tx.a * c.a);
    }
    fragColor = vec4(c.rgb * c.a, c.a);
    return;
  }
  if (v_kind == 2) {
    float r = max(v_rr.x, 0.5);
    float cov = v_shape == 1 ? sp_aa(r - length(v_d)) : sp_aa(r * 0.75 - abs(v_d.x)) * sp_aa(r * 0.75 - abs(v_d.y));
    vec2 tuv = (v_d / (v_shape == 1 ? r : r * 0.75)) * 0.5 + 0.5;
    vec4 tx = u_texture_size.x > 0.0 ? texture(u_texture, fract(tuv + v_tuv)) : vec4(1.0);
    vec4 c = vec4(fx_unpremultiply(tx).rgb * v_col.rgb, tx.a * v_col.a * cov);
    fragColor = vec4(c.rgb * c.a, c.a);
    return;
  }
  if (v_kind == 3) {
    float r = max(v_rr.x, 0.5);
    vec2 d = v_d / r;
    float dd = length(d);
    float cov = sp_aa((1.0 - dd) * r);
    if (cov <= 0.0) { fragColor = vec4(0.0); return; }
    float nz = sqrt(max(1.0 - dd * dd, 0.0));
    // Convex magnifies, concave shrinks; the others refract mildly.
    float k = ptype == 14 ? 0.45 : (ptype == 15 ? 1.8 : 0.8);
    vec4 b = texture(u_source, (v_ctr + v_d * k) / u_canvasSize);
    vec3 c = b.a > 0.0 ? b.rgb / b.a : vec3(0.0);
    float a = cov * v_col.a * max(b.a, 0.0);
    if (ptype == 16) a *= nz;
    if (ptype == 17) c *= 0.3 + 0.7 * nz;
    if (ptype == 18) {
      float ring = max(1.0 - pow((dd - 0.9) / 0.12, 2.0), 0.0);
      c += ring * 0.6;
      a = max(a, ring * cov * v_col.a);
    }
    vec2 hp = d + 0.35;
    c += max(1.0 - dot(hp, hp) / 0.05, 0.0) * 0.5;
    fragColor = vec4(c * a, a);
    return;
  }
  fragColor = sp_shade(v_shape, v_d, v_rr.x, v_rr.y, v_seg, v_col);
}
`;

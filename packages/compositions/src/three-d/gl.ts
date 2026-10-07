// three-d: the Classic 3D renderer on the GPU (WebGL2, the fx host's shared context) — the same algorithm as the CPU
// reference `compositeClassicCPU` in @jasper/project (and EffectCraft's classic3d.wgsl, MIT OR Apache-2.0):
// 1. the planes' pictures are packed into one atlas (uploaded premultiplied);
// 2. depth of field (per plane with a camera DOF): highlight boost, a row prefix sum (Hillis–Steele scan in float
//    targets) and a gather with the iris' row-span kernels at the two blur levels bracketing each pixel's radius —
//    exactly the CPU's `progressiveBlur` with the shared `dofLevels`;
// 3. one full-frame pass: per output pixel every plane is inverse-mapped through its homography, sampled bilinearly
//    (transparent outside its picture), shaded (Blinn-Phong, spot cones, falloff, ray-cast shadows against the
//    casting planes, Light Transmission), the fragments insertion-sorted far → near (coplanar in stack order) and
//    blended over the backdrop with `fx_layerBlend` (the blend formulas of every other path).
// Plane and light parameters travel in RGBA32F data textures, so a run may hold any number of planes and lights.
import {
	blendModeIndex,
	type ClassicPlane,
	type ClassicSetup,
	dofLevels,
	GLSL_BLEND,
	type Iris,
	kernelSpans,
	type LightState,
	pictureScale,
} from '@jasper/project';
import { blit, compileShader, ensureCanvas, type FxHost } from '../fx/host.ts';

/** Per-pixel fragment limit of the composite (layers beyond it at one pixel are left out, as in EffectCraft). */
export const MAX_FRAGS = 32;
const PLANE_TEXELS = 20;
const LIGHT_TEXELS = 6;
const SPAN_ROW = 1024;

/** A plane with its picture for the GPU (`picture` = the unpadded layer picture; the plane's DOF pads it). */
export type GlPlane = ClassicPlane & {
	picture: TexImageSource;
	/** Size of `picture` (pixels): the plane's size minus its DOF padding. */
	pictureWidth: number;
	pictureHeight: number;
};

const VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

function blendSource(): string {
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (c: { name: string; source: string; deps?: readonly { name: string; source: string }[] }) => {
		if (seen.has(c.name)) return;
		seen.add(c.name);
		for (const d of c.deps ?? []) add(d);
		out.push(c.source);
	};
	add(GLSL_BLEND as never);
	// Only the clip blend formulas (the effect blends after them read effect uniforms).
	const src = out.join('\n');
	const cut = src.indexOf('// ---- effect blends');
	return cut > 0 ? src.slice(0, cut) : src;
}

const COMPOSITE_FS = () => `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D u_atlas;
uniform sampler2D u_backdrop;
uniform sampler2D u_planes;
uniform sampler2D u_lights;
uniform int u_planeCount;
uniform int u_lightCount;
uniform int u_hasBackdrop;
uniform vec2 u_size;
uniform vec3 u_eye;
uniform vec3 u_fwd;
uniform int u_ortho;
out vec4 fragColor;
${blendSource()}
const int MAX_FRAGS = ${MAX_FRAGS};
const float NEAR3 = 1.0;
vec4 P(int i, int k) { return texelFetch(u_planes, ivec2(k, i), 0); }
vec4 L(int i, int k) { return texelFetch(u_lights, ivec2(k, i), 0); }

vec4 atlasGet(vec4 rect, int x, int y) {
  if (x < 0 || y < 0 || x >= int(rect.z) || y >= int(rect.w)) return vec4(0.0);
  return texelFetch(u_atlas, ivec2(int(rect.x) + x, int(rect.y) + y), 0);
}
// Bilinear sample of plane i at layer (u, v), transparent outside its picture (= samplePicture).
vec4 texel(int i, float u, float v) {
  vec4 a = P(i, 6);
  vec4 b = P(i, 7);
  vec4 rect = P(i, 8);
  vec4 c = P(i, 19);
  float w = c.y * u + c.z * v + c.w;
  float x = (a.x * u + a.y * v + a.z) / w;
  float y = (b.x * u + b.y * v + b.z) / w;
  float fx = x - 0.5;
  float fy = y - 0.5;
  float x0 = floor(fx);
  float y0 = floor(fy);
  int xi = int(x0);
  int yi = int(y0);
  float tx = fx - x0;
  float ty = fy - y0;
  vec4 p00 = atlasGet(rect, xi, yi);
  vec4 p10 = atlasGet(rect, xi + 1, yi);
  vec4 p01 = atlasGet(rect, xi, yi + 1);
  vec4 p11 = atlasGet(rect, xi + 1, yi + 1);
  vec4 top = p00 + (p10 - p00) * tx;
  vec4 bot = p01 + (p11 - p01) * tx;
  return top + (bot - top) * ty;
}
vec3 affine(vec4 r0, vec4 r1, vec4 r2, vec3 p) {
  return vec3(dot(r0.xyz, p) + r0.w, dot(r1.xyz, p) + r1.w, dot(r2.xyz, p) + r2.w);
}
// (u, v, depth, ok)
vec4 unproject(int i, float sx, float sy) {
  vec4 h0 = P(i, 0);
  vec4 h1 = P(i, 1);
  vec4 h2 = P(i, 2);
  bool ortho = u_ortho == 1;
  float qz = h2.x * sx + h2.y * sy + h2.z;
  if ((!ortho && qz <= 0.0) || qz == 0.0) return vec4(0.0);
  float u = (h0.x * sx + h0.y * sy + h0.z) / qz;
  float v = (h1.x * sx + h1.y * sy + h1.z) / qz;
  vec4 d = P(i, 3);
  float z = d.x * u + d.y * v + d.z;
  if (!ortho && z < NEAR3) return vec4(0.0);
  return vec4(u, v, z, 1.0);
}
// (unit vector to the light, distance; -1 = infinite)
vec4 toLight(int l, vec3 p) {
  vec4 t = L(l, 0);
  if (int(t.x) == 1) return vec4(-L(l, 2).xyz, -1.0);
  vec3 d = L(l, 1).xyz - p;
  float len = length(d);
  if (len < 1e-9) return vec4(0.0, 0.0, -1.0, 0.0);
  return vec4(d / len, len);
}
float smoothFall(float t) { return 1.0 - t * t * (3.0 - 2.0 * t); }
float attenuation(int l, vec3 p) {
  vec4 t = L(l, 0);
  vec4 cone = L(l, 4);
  vec4 tl = toLight(l, p);
  float dist = tl.w;
  bool finite = dist >= 0.0;
  float radius = cone.z;
  float fd = cone.w;
  float k = 1.0;
  int falloff = int(t.y);
  if (falloff == 1 && finite) {
    if (dist <= radius) k = 1.0;
    else if (fd <= 0.0) k = 0.0;
    else k = smoothFall(clamp((dist - radius) / fd, 0.0, 1.0));
  } else if (falloff == 2 && finite) {
    if (dist <= radius || (radius <= 0.0 && dist <= 1.0)) k = 1.0;
    else { float q = max(radius, 1.0) / dist; k = q * q; }
  }
  if (int(t.x) == 3) {
    float cosA = clamp(dot(-tl.xyz, L(l, 2).xyz), -1.0, 1.0);
    float a = acos(cosA);
    float outer = cone.x;
    float inner = outer * (1.0 - cone.y);
    if (a >= outer) k = 0.0;
    else if (a > inner) k *= smoothFall((a - inner) / max(outer - inner, 1e-9));
  }
  return k;
}
vec3 occlusion(int c, vec3 p, int l) {
  vec4 lt = L(l, 0);
  bool parallel = int(lt.x) == 1;
  vec3 dir = L(l, 2).xyz;
  vec3 target = parallel ? p - dir * 1.0e6 : L(l, 1).xyz;
  vec4 w0 = P(c, 12);
  vec4 w1 = P(c, 13);
  vec4 w2 = P(c, 14);
  vec3 a = affine(w0, w1, w2, p);
  vec3 b = affine(w0, w1, w2, target);
  if (a.z == b.z || sign(a.z) == sign(b.z)) return vec3(1.0);
  float t = a.z / (a.z - b.z);
  if (t <= 1e-6 || t >= 1.0 - 1e-9) return vec3(1.0);
  vec2 hit = a.xy + (b.xy - a.xy) * t;
  float seg = length(target - p);
  float dPc = seg * t;
  float dCl = parallel ? 1000.0 : max(seg * (1.0 - t), 1.0);
  float r = L(l, 5).y * min(dPc / dCl, 4.0);
  vec4 bd = P(c, 5);
  if (hit.x < bd.x - r || hit.y < bd.y - r || hit.x > bd.z + r || hit.y > bd.w + r) return vec3(1.0);
  float s = P(c, 7).w;
  vec4 px = vec4(0.0);
  if (r * s < 0.5) px = texel(c, hit.x, hit.y);
  else {
    for (int j = -1; j <= 1; j++)
      for (int i = -1; i <= 1; i++)
        px += texel(c, hit.x + float(i) * r * 0.66, hit.y + float(j) * r * 0.66) / 9.0;
  }
  float alpha = clamp(px.a * P(c, 3).w, 0.0, 1.0);
  if (alpha <= 0.0) return vec3(1.0);
  float tr = P(c, 17).x;
  float dark = L(l, 5).x;
  vec3 straight = px.a > 0.0 ? clamp(px.rgb / px.a, 0.0, 1.0) : vec3(0.0);
  vec3 pass = (1.0 - alpha) + alpha * tr * straight;
  return 1.0 - dark * (1.0 - pass);
}
vec4 shade(int it, float u, float v, vec4 t) {
  vec4 m2 = P(it, 17);
  int acceptsShadows = int(m2.z);
  if (u_lightCount == 0 || m2.w < 0.5) return acceptsShadows == 2 ? vec4(0.0) : t;
  float a = t.a;
  vec3 rgb = t.rgb / a;
  vec3 p = affine(P(it, 9), P(it, 10), P(it, 11), vec3(u, v, 0.0));
  vec3 view = u_ortho == 1 ? -u_fwd : normalize(u_eye - p);
  vec4 nm = P(it, 15);
  vec3 n = nm.xyz;
  if (dot(n, view) < 0.0) n = -n;
  vec4 m1 = P(it, 16);
  float metal = nm.w;
  float transmission = m2.x;
  float specular = m1.z;
  float ex = m1.w;
  vec3 amb = vec3(0.0);
  vec3 diff = vec3(0.0);
  vec3 spec = vec3(0.0);
  float shadowAmt = 0.0;
  for (int l = 0; l < u_lightCount; l++) {
    vec4 lt = L(l, 0);
    vec3 color = L(l, 3).xyz;
    if (int(lt.x) == 0) { amb += color; continue; }
    float k = attenuation(l, p);
    if (k <= 0.0) continue;
    vec3 lv = toLight(l, p).xyz;
    float ndl = dot(n, lv);
    bool front = ndl > 0.0;
    float lambert = front ? ndl : -ndl * transmission;
    if (lambert <= 0.0) continue;
    vec3 sh = vec3(1.0);
    if (lt.z > 0.5 && acceptsShadows != 0) {
      for (int c = 0; c < u_planeCount; c++) {
        // A plane never shadows itself (nor the other planes of its layer: per-character planes share the order).
        if (c == it || P(c, 17).y < 0.5 || P(c, 18).w == P(it, 18).w) continue;
        sh *= occlusion(c, p, l);
      }
    }
    shadowAmt = max(shadowAmt, 1.0 - (sh.x + sh.y + sh.z) / 3.0);
    diff += color * (lambert * k) * sh;
    if (front && specular > 0.0) {
      vec3 hv = normalize(lv + view);
      float s = pow(max(dot(n, hv), 0.0), ex) * k;
      vec3 tint = vec3(1.0) + (rgb - vec3(1.0)) * metal;
      spec += color * s * sh * tint;
    }
  }
  if (acceptsShadows == 2) return vec4(0.0, 0.0, 0.0, a * shadowAmt);
  return vec4((rgb * (m1.x * amb + m1.y * diff) + specular * spec) * a, a);
}
bool before(float za, float oa, float zb, float ob) {
  float tol = 1e-5 * max(max(abs(za), abs(zb)), 1.0);
  if (abs(za - zb) <= tol) return oa < ob;
  return za > zb;
}
void main() {
  float fx = floor(gl_FragCoord.x);
  float fy = floor(u_size.y - gl_FragCoord.y);
  float sx = fx + 0.5;
  float sy = fy + 0.5;
  vec4 d = u_hasBackdrop == 1 ? texelFetch(u_backdrop, ivec2(int(fx), int(fy)), 0) : vec4(0.0);
  float fz[MAX_FRAGS];
  float fo[MAX_FRAGS];
  int fi[MAX_FRAGS];
  vec4 fp[MAX_FRAGS];
  int nf = 0;
  for (int i = 0; i < u_planeCount; i++) {
    vec4 bbox = P(i, 4);
    if (P(i, 19).x < 0.5) continue;
    if (fx < bbox.x || fx >= bbox.z || fy < bbox.y || fy >= bbox.w) continue;
    vec4 q = unproject(i, sx, sy);
    if (q.w == 0.0) continue;
    vec4 t = texel(i, q.x, q.y);
    if (t.a <= 1e-6) continue;
    vec4 px = shade(i, q.x, q.y, t);
    if (!(px.a > 0.0 || px.r != 0.0 || px.g != 0.0 || px.b != 0.0) || nf >= MAX_FRAGS) continue;
    float order = P(i, 18).w;
    int j = nf;
    while (j > 0 && before(q.z, order, fz[j - 1], fo[j - 1])) {
      fz[j] = fz[j - 1];
      fo[j] = fo[j - 1];
      fi[j] = fi[j - 1];
      fp[j] = fp[j - 1];
      j--;
    }
    fz[j] = q.z;
    fo[j] = order;
    fi[j] = i;
    fp[j] = px;
    nf++;
  }
  for (int k = 0; k < nf; k++) {
    int i = fi[k];
    vec4 s = fp[k] * P(i, 3).w;
    vec4 md = P(i, 18);
    int mode = int(md.x);
    float noise = 0.5;
    if (mode == FX_LAYER_DISSOLVE) {
      uint seed = (uint(md.y) << 16u) | uint(md.z);
      noise = fx_blendNoise(uvec2(uint(fx), uint(fy)), seed);
    }
    d = fx_layerBlend(mode, d, s, noise);
  }
  fragColor = fx_clampPremul(d);
}
`;

// ---------------------------------------------------------------- depth of field passes

const DOF_INIT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_atlas;
uniform vec4 u_rect;
uniform vec3 u_highlight; // gain, threshold, saturation
out vec4 fragColor;
float lum709(vec3 c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
void main() {
  int x = int(gl_FragCoord.x) - 1;
  int y = int(gl_FragCoord.y);
  if (x < 0 || x >= int(u_rect.z)) { fragColor = vec4(0.0); return; }
  vec4 p = texelFetch(u_atlas, ivec2(int(u_rect.x) + x, int(u_rect.y) + y), 0);
  float gain = u_highlight.x;
  if (gain > 0.0 && p.a > 0.0) {
    vec3 c = p.rgb / p.a;
    float l = lum709(c);
    float thr = clamp(u_highlight.y, 0.0, 1.0);
    if (!(l < thr || (thr >= 1.0 && l < 1.0))) {
      float over = thr < 1.0 ? clamp((l - thr) / (1.0 - thr), 0.0, 1.0) : 1.0;
      float k = 1.0 + gain * 4.0 * max(over, 0.25);
      float sat = 1.0 + u_highlight.z;
      p = vec4(max(vec3(l) + (c - vec3(l)) * sat, 0.0) * k * p.a, p.a);
    }
  }
  fragColor = p;
}
`;

const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
out vec4 fragColor;
void main() { fragColor = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0); }
`;

const DOF_SCAN_FS = `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform int u_step;
out vec4 fragColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 v = texelFetch(u_prev, p, 0);
  if (p.x >= u_step) v += texelFetch(u_prev, ivec2(p.x - u_step, p.y), 0);
  fragColor = v;
}
`;

const DOF_GATHER_FS = `#version 300 es
precision highp float;
uniform sampler2D u_prefix;
uniform sampler2D u_spans;
uniform vec2 u_origin;      // region origin in the target
uniform vec2 u_regionSize;  // padded picture size
uniform vec3 u_zPlane;
uniform float u_k;          // radius = coc(z)·z·k
uniform vec3 u_dof;         // aperture, focus, blur level
uniform float u_maxRadius;
uniform int u_levelCount;
uniform float u_levels[8];
uniform int u_spanCount[8];
uniform float u_norm[8];
uniform int u_rowsPerLevel;
out vec4 fragColor;
const int SPAN_ROW = ${SPAN_ROW};
vec4 prefixAt(int y, float t) {
  float n = u_regionSize.x;
  if (t <= 0.0) return vec4(0.0);
  if (t >= n) return texelFetch(u_prefix, ivec2(int(n), y), 0);
  float i = floor(t);
  float f = t - i;
  vec4 a = texelFetch(u_prefix, ivec2(int(i), y), 0);
  vec4 b = texelFetch(u_prefix, ivec2(int(i) + 1, y), 0);
  return a + (b - a) * f;
}
vec4 gather(int level, float x, float y) {
  vec4 acc = vec4(0.0);
  int n = u_spanCount[level];
  for (int s = 0; s < n; s++) {
    vec4 sp = texelFetch(u_spans, ivec2(s % SPAN_ROW, level * u_rowsPerLevel + s / SPAN_ROW), 0);
    int sy = int(y) + int(sp.x);
    if (sy < 0 || sy >= int(u_regionSize.y)) continue;
    acc += (prefixAt(sy, x + sp.z + 0.5) - prefixAt(sy, x + sp.y + 0.5)) * sp.w;
  }
  return acc / u_norm[level];
}
float radiusAt(float px, float py) {
  float z = u_zPlane.x + u_zPlane.y * px + u_zPlane.z * py;
  if (z <= 1.0 || u_dof.y <= 0.0) return 0.0;
  float coc = u_dof.x * abs(z - u_dof.y) / z * u_dof.z;
  return min(u_maxRadius, coc * z * u_k);
}
void main() {
  float x = floor(gl_FragCoord.x - u_origin.x);
  float y = floor(gl_FragCoord.y - u_origin.y);
  if (u_levelCount == 1) { fragColor = gather(0, x, y); return; }
  float r = radiusAt(x + 0.5, y + 0.5);
  float lo = u_levels[0];
  float hi = u_levels[u_levelCount - 1];
  float n1 = float(u_levelCount - 1);
  float f = clamp((r - lo) / (hi - lo) * n1, 0.0, n1);
  int k = min(u_levelCount - 2, int(floor(f)));
  float t = f - float(k);
  vec4 a = gather(k, x, y);
  vec4 b = gather(k + 1, x, y);
  fragColor = a + (b - a) * t;
}
`;

// ---------------------------------------------------------------- GL plumbing

type Programs = {
	composite: WebGLProgram;
	dofInit: WebGLProgram;
	dofScan: WebGLProgram;
	dofGather: WebGLProgram;
	copy: WebGLProgram;
	locs: Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>;
	tex: Map<string, WebGLTexture>;
	fbo: WebGLFramebuffer;
};
const cache = new WeakMap<WebGL2RenderingContext, Programs>();

function link(gl: WebGL2RenderingContext, fsSrc: string, label: string): WebGLProgram {
	const vs = compileShader(gl, gl.VERTEX_SHADER, VS);
	if (typeof vs === 'string') throw new Error(`WEBGL_UNAVAILABLE: 3D renderer vertex shader: ${vs}`);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
	if (typeof fs === 'string') throw new Error(`WEBGL_UNAVAILABLE: 3D renderer ${label} shader: ${fs}`);
	const p = gl.createProgram()!;
	gl.attachShader(p, vs);
	gl.attachShader(p, fs);
	gl.bindAttribLocation(p, 0, 'a_pos');
	gl.linkProgram(p);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
		throw new Error(`WEBGL_UNAVAILABLE: 3D renderer ${label} link: ${gl.getProgramInfoLog(p) ?? ''}`);
	return p;
}

function programs(gl: WebGL2RenderingContext): Programs {
	let p = cache.get(gl);
	if (p) return p;
	p = {
		composite: link(gl, COMPOSITE_FS(), 'composite'),
		dofInit: link(gl, DOF_INIT_FS, 'depth of field'),
		dofScan: link(gl, DOF_SCAN_FS, 'depth of field'),
		dofGather: link(gl, DOF_GATHER_FS, 'depth of field'),
		copy: link(gl, COPY_FS, 'copy'),
		locs: new Map(),
		tex: new Map(),
		fbo: gl.createFramebuffer()!,
	};
	cache.set(gl, p);
	return p;
}

function loc(
	gl: WebGL2RenderingContext,
	ps: Programs,
	prog: WebGLProgram,
	name: string,
): WebGLUniformLocation | null {
	let m = ps.locs.get(prog);
	if (!m) {
		m = new Map();
		ps.locs.set(prog, m);
	}
	if (!m.has(name)) m.set(name, gl.getUniformLocation(prog, name));
	return m.get(name)!;
}

/** A named, reused texture (re-allocated when its size or format changes). */
function tex(
	gl: WebGL2RenderingContext,
	ps: Programs,
	name: string,
	w: number,
	h: number,
	fmt: 'rgba8' | 'rgba32f' | 'rgba16f',
): WebGLTexture {
	const key = `${name}`;
	let t = ps.tex.get(key);
	const sizeKey = `${w}x${h}:${fmt}`;
	if (t && (t as { __size?: string }).__size === sizeKey) return t;
	if (t) gl.deleteTexture(t);
	t = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D, t);
	for (const [k, v] of [
		[gl.TEXTURE_MIN_FILTER, gl.NEAREST],
		[gl.TEXTURE_MAG_FILTER, gl.NEAREST],
		[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
		[gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
	] as const)
		gl.texParameteri(gl.TEXTURE_2D, k, v);
	if (fmt === 'rgba8') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	else if (fmt === 'rgba16f')
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
	else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
	(t as { __size?: string }).__size = sizeKey;
	ps.tex.set(key, t);
	return t;
}

function dataTexture(
	gl: WebGL2RenderingContext,
	ps: Programs,
	name: string,
	w: number,
	h: number,
	data: Float32Array,
) {
	const t = tex(gl, ps, name, w, Math.max(1, h), 'rgba32f');
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
	if (h > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, data);
	return t;
}

// ---------------------------------------------------------------- atlas

export type AtlasSlot = { x: number; y: number; w: number; h: number };

/** Shelf packing of rectangles (tallest first); null when it does not fit `max`×`max`. */
export function packAtlas(
	sizes: { w: number; h: number }[],
	max: number,
): { slots: AtlasSlot[]; width: number; height: number } | null {
	const order = sizes.map((_s, i) => i).sort((a, b) => sizes[b]!.h - sizes[a]!.h);
	const area = sizes.reduce((s, x) => s + x.w * x.h, 0);
	const widest = sizes.reduce((m, x) => Math.max(m, x.w), 1);
	const width = Math.min(max, Math.max(widest, Math.ceil(Math.sqrt(area) * 1.2)));
	if (widest > max) return null;
	const slots: AtlasSlot[] = new Array(sizes.length);
	let x = 0;
	let y = 0;
	let shelf = 0;
	for (const i of order) {
		const s = sizes[i]!;
		if (x + s.w > width) {
			y += shelf;
			x = 0;
			shelf = 0;
		}
		slots[i] = { x, y, w: s.w, h: s.h };
		x += s.w;
		shelf = Math.max(shelf, s.h);
	}
	const height = Math.max(1, y + shelf);
	return height > max ? null : { slots, width, height };
}

// ---------------------------------------------------------------- the render

export type ClassicGlInput = {
	setup: ClassicSetup;
	planes: GlPlane[];
	/** The composite below the run (output size), or null (transparent). */
	backdrop: TexImageSource | null;
};

/**
 * Renders a 3D run on the fx host's context into `out` (the output size). Throws `WEBGL_UNAVAILABLE` on a lost
 * context or a missing capability, `THREE_D_TOO_LARGE` when the pictures cannot fit one atlas.
 */
export function renderClassicGL(h: FxHost, input: ClassicGlInput, out: CanvasRenderingContext2D): void {
	const { gl } = h;
	if (h.lost || gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the GPU context is lost');
	const ps = programs(gl);
	const { setup, planes } = input;
	const W = Math.max(1, Math.round(setup.width));
	const H = Math.max(1, Math.round(setup.height));
	const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
	const draft = !!setup.draft;
	const dofOn = !draft && !!setup.camera.dof;
	// 1. atlas
	const pack = packAtlas(
		planes.map((p) => ({ w: Math.ceil(p.width), h: Math.ceil(p.height) })),
		maxTex,
	);
	if (!pack)
		throw new Error(
			`THREE_D_TOO_LARGE: the pictures of this 3D run do not fit a ${maxTex}×${maxTex} texture (lower the layers' resolution)`,
		);
	gl.disable(gl.BLEND);
	gl.disable(gl.SCISSOR_TEST);
	gl.disable(gl.DEPTH_TEST);
	const raw = tex(gl, ps, 'atlasRaw', pack.width, pack.height, 'rgba8');
	gl.bindFramebuffer(gl.FRAMEBUFFER, ps.fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, raw, 0);
	gl.viewport(0, 0, pack.width, pack.height);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	gl.bindTexture(gl.TEXTURE_2D, raw);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
	gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
	planes.forEach((p, i) => {
		const s = pack.slots[i]!;
		const pad = p.dof?.pad ?? 0;
		if (p.pictureWidth > 0 && p.pictureHeight > 0)
			gl.texSubImage2D(gl.TEXTURE_2D, 0, s.x + pad, s.y + pad, gl.RGBA, gl.UNSIGNED_BYTE, p.picture);
	});
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	let atlas = raw;
	// 2. depth of field
	const blurred = dofOn ? planes.filter((p) => p.dof) : [];
	if (blurred.length > 0) {
		if (!h.floatTargets)
			throw new Error(
				'WEBGL_UNAVAILABLE: depth of field needs float render targets (EXT_color_buffer_float)',
			);
		const final = tex(gl, ps, 'atlasDof', pack.width, pack.height, 'rgba16f');
		// Copy the unblurred atlas (a pass: 8-bit → half float), then overwrite the blurred regions.
		const drawFbo = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, drawFbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, final, 0);
		gl.viewport(0, 0, pack.width, pack.height);
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		gl.useProgram(ps.copy);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, raw);
		gl.uniform1i(loc(gl, ps, ps.copy, 'u_src'), 0);
		gl.bindVertexArray(h.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		for (const p of blurred) {
			const i = planes.indexOf(p);
			runDof(gl, ps, h, p, pack.slots[i]!, raw, drawFbo, setup);
		}
		gl.deleteFramebuffer(drawFbo);
		atlas = final;
	}
	// 3. data textures
	const pd = new Float32Array(Math.max(1, planes.length) * PLANE_TEXELS * 4);
	planes.forEach((p, i) => {
		const s = pack.slots[i]!;
		const o = i * PLANE_TEXELS * 4;
		const put = (k: number, a: number, b: number, c: number, d: number) => pd.set([a, b, c, d], o + k * 4);
		const hv = p.hinv;
		put(0, hv[0], hv[1], hv[2], 0);
		put(1, hv[3], hv[4], hv[5], 0);
		put(2, hv[6], hv[7], hv[8], 0);
		put(3, p.depth[0], p.depth[1], p.depth[2], p.opacity);
		put(4, p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]);
		put(5, p.bounds[0], p.bounds[1], p.bounds[2], p.bounds[3]);
		const m = p.layerToPicture;
		const sc = pictureScale(m);
		put(6, m[0], m[1], m[2], 0);
		put(7, m[3], m[4], m[5], sc);
		put(8, s.x, s.y, s.w, s.h);
		const w = p.world;
		put(9, w[0]!, w[1]!, w[2]!, w[3]!);
		put(10, w[4]!, w[5]!, w[6]!, w[7]!);
		put(11, w[8]!, w[9]!, w[10]!, w[11]!);
		const v = p.winv;
		put(12, v[0]!, v[1]!, v[2]!, v[3]!);
		put(13, v[4]!, v[5]!, v[6]!, v[7]!);
		put(14, v[8]!, v[9]!, v[10]!, v[11]!);
		const mt = p.material;
		put(15, p.normal[0], p.normal[1], p.normal[2], mt.metal);
		put(16, mt.ambient, mt.diffuse, mt.specular, Math.max(1, 256 ** mt.shininess));
		put(17, mt.lightTransmission, mt.castsShadows, mt.acceptsShadows, mt.acceptsLights ? 1 : 0);
		const seed = p.seed >>> 0;
		put(18, blendModeIndex(p.mode), seed >>> 16, seed & 0xffff, p.order);
		put(19, p.draw ? 1 : 0, m[6], m[7], m[8]);
	});
	const lights: LightState[] = draft ? [] : setup.lights;
	const ld = new Float32Array(Math.max(1, lights.length) * LIGHT_TEXELS * 4);
	const TYPE = { ambient: 0, parallel: 1, point: 2, spot: 3, environment: 0 } as const;
	lights.forEach((l, i) => {
		const o = i * LIGHT_TEXELS * 4;
		ld.set([TYPE[l.type], l.falloff, l.castsShadows ? 1 : 0, 0], o);
		ld.set([l.pos[0], l.pos[1], l.pos[2], 0], o + 4);
		ld.set([l.dir[0], l.dir[1], l.dir[2], 0], o + 8);
		ld.set([l.color[0], l.color[1], l.color[2], 0], o + 12);
		ld.set([l.coneHalf, l.feather, l.radius, l.falloffDistance], o + 16);
		ld.set([l.shadowDarkness, l.shadowDiffusion, 0, 0], o + 20);
	});
	const planeTex = dataTexture(gl, ps, 'planes', PLANE_TEXELS, planes.length, pd);
	const lightTex = dataTexture(gl, ps, 'lights', LIGHT_TEXELS, lights.length, ld);
	// 4. composite into the shared canvas
	const back = tex(gl, ps, 'backdrop', W, H, 'rgba8');
	if (input.backdrop) {
		gl.bindTexture(gl.TEXTURE_2D, back);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, input.backdrop);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		(back as { __size?: string }).__size = undefined;
	}
	ensureCanvas(h, W, H);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, W, H);
	const prog = ps.composite;
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(prog);
	const bindTex = (unit: number, t: WebGLTexture, name: string) => {
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.uniform1i(loc(gl, ps, prog, name), unit);
	};
	bindTex(0, atlas, 'u_atlas');
	bindTex(1, back, 'u_backdrop');
	bindTex(2, planeTex, 'u_planes');
	bindTex(3, lightTex, 'u_lights');
	gl.uniform1i(loc(gl, ps, prog, 'u_planeCount'), planes.length);
	gl.uniform1i(loc(gl, ps, prog, 'u_lightCount'), lights.length);
	gl.uniform1i(loc(gl, ps, prog, 'u_hasBackdrop'), input.backdrop ? 1 : 0);
	gl.uniform2f(loc(gl, ps, prog, 'u_size'), W, H);
	const cam = setup.camera;
	gl.uniform3f(loc(gl, ps, prog, 'u_eye'), cam.eye[0], cam.eye[1], cam.eye[2]);
	gl.uniform3f(loc(gl, ps, prog, 'u_fwd'), cam.view[8]!, cam.view[9]!, cam.view[10]!);
	gl.uniform1i(loc(gl, ps, prog, 'u_ortho'), cam.ortho ? 1 : 0);
	gl.bindVertexArray(h.vao);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.bindVertexArray(null);
	gl.activeTexture(gl.TEXTURE0);
	if (gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the GPU context was lost while drawing');
	blit(h, out, W, H);
}

function runDof(
	gl: WebGL2RenderingContext,
	ps: Programs,
	h: FxHost,
	p: GlPlane,
	slot: AtlasSlot,
	raw: WebGLTexture,
	drawFbo: WebGLFramebuffer,
	setup: ClassicSetup,
): void {
	const dof = setup.camera.dof!;
	const levels = dofLevels(p);
	if (!levels) return;
	const rw = slot.w;
	const rh = slot.h;
	// Prefix: column 0 = 0, column x = sum of pixels 0…x−1 (boosted highlights).
	const pw = rw + 1;
	const a = tex(gl, ps, 'dofA', pw, rh, 'rgba32f');
	const b = tex(gl, ps, 'dofB', pw, rh, 'rgba32f');
	const draw = (prog: WebGLProgram, target: WebGLTexture, vw: number, vh: number) => {
		gl.bindFramebuffer(gl.FRAMEBUFFER, ps.fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
		gl.viewport(0, 0, vw, vh);
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		gl.useProgram(prog);
	};
	draw(ps.dofInit, a, pw, rh);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, raw);
	gl.uniform1i(loc(gl, ps, ps.dofInit, 'u_atlas'), 0);
	gl.uniform4f(loc(gl, ps, ps.dofInit, 'u_rect'), slot.x, slot.y, rw, rh);
	gl.uniform3f(
		loc(gl, ps, ps.dofInit, 'u_highlight'),
		dof.highlight.gain,
		dof.highlight.threshold,
		dof.highlight.saturation,
	);
	gl.bindVertexArray(h.vao);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	let src = a;
	let dst = b;
	for (let step = 1; step < pw; step *= 2) {
		draw(ps.dofScan, dst, pw, rh);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, src);
		gl.uniform1i(loc(gl, ps, ps.dofScan, 'u_prev'), 0);
		gl.uniform1i(loc(gl, ps, ps.dofScan, 'u_step'), step);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		[src, dst] = [dst, src];
	}
	// Span kernels of the levels.
	const kernels = levels.map((r) => kernelSpans(dof.iris as Iris, r));
	// A level without a kernel (radius < 0.3 px) copies the pixel: one unit span.
	const spanLists = kernels.map((k) =>
		k ? k.kernels.flatMap((kk) => kk.spans.map((s) => [s[0], s[1], s[2], kk.weight])) : [[0, -0.5, 0.5, 1]],
	);
	const maxSpans = Math.max(1, ...spanLists.map((l) => l.length));
	const rowsPerLevel = Math.ceil(maxSpans / SPAN_ROW);
	const sd = new Float32Array(SPAN_ROW * rowsPerLevel * levels.length * 4);
	spanLists.forEach((list, li) => {
		list.forEach((s, si) => {
			const x = si % SPAN_ROW;
			const y = li * rowsPerLevel + Math.floor(si / SPAN_ROW);
			sd.set(s, (y * SPAN_ROW + x) * 4);
		});
	});
	const spanTex = dataTexture(gl, ps, 'spans', SPAN_ROW, rowsPerLevel * levels.length, sd);
	// Gather into the final atlas region.
	gl.bindFramebuffer(gl.FRAMEBUFFER, drawFbo);
	gl.viewport(slot.x, slot.y, rw, rh);
	const g = ps.dofGather;
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(g);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, src);
	gl.uniform1i(loc(gl, ps, g, 'u_prefix'), 0);
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, spanTex);
	gl.uniform1i(loc(gl, ps, g, 'u_spans'), 1);
	gl.uniform2f(loc(gl, ps, g, 'u_origin'), slot.x, slot.y);
	gl.uniform2f(loc(gl, ps, g, 'u_regionSize'), rw, rh);
	const z = p.dof!.zPlane;
	gl.uniform3f(loc(gl, ps, g, 'u_zPlane'), z[0], z[1], z[2]);
	gl.uniform1f(loc(gl, ps, g, 'u_k'), p.dof!.k);
	gl.uniform3f(loc(gl, ps, g, 'u_dof'), dof.aperture, dof.focus, dof.blurLevel);
	gl.uniform1f(loc(gl, ps, g, 'u_maxRadius'), 192);
	gl.uniform1i(loc(gl, ps, g, 'u_levelCount'), levels.length);
	const lv = new Float32Array(8);
	lv.set(levels);
	gl.uniform1fv(loc(gl, ps, g, 'u_levels'), lv);
	const counts = new Int32Array(8);
	const norms = new Float32Array(8).fill(1);
	kernels.forEach((k, i) => {
		counts[i] = spanLists[i]!.length;
		norms[i] = k ? k.norm : 1;
	});
	gl.uniform1iv(loc(gl, ps, g, 'u_spanCount'), counts);
	gl.uniform1fv(loc(gl, ps, g, 'u_norm'), norms);
	gl.uniform1i(loc(gl, ps, g, 'u_rowsPerLevel'), rowsPerLevel);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.bindVertexArray(null);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

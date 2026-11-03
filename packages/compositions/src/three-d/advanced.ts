// three-d: the Advanced 3D renderer (docs/wp-notes/three-d.md) on the fx host's shared WebGL2 context. Where Classic
// 3D composites planes per pixel, Advanced 3D rasterises real geometry with a depth buffer and 4× multisampling:
// layers are textured quads (any corner pin), text and shape layers with Geometry Options are extruded solids
// (extrude.ts: front / back faces, bevels, walls) and everything is lit physically — Lambert diffuse plus a GGX
// microfacet specular (Smith visibility, Schlick Fresnel) whose roughness is 1 − Specular Shininess, tinted by Metal —
// with the same light falloffs and spot cones as Classic 3D. Shadows are shadow maps (spot: perspective, parallel:
// orthographic over the scene, point: six faces) filtered by Shadow Diffusion (PCF); Accepts Shadows "Only" draws a
// shadow catcher. An environment light lights diffusely from its equirectangular image (a blurred mip along the
// normal), reflects it by Reflection Intensity / Sharpness (mip by roughness, Fresnel) and can be the background.
// Transparent pixels are drawn after the opaque ones, far to near, without depth writes. The camera's depth of field
// is a screen-space gather over the depth of the nearest surface (iris polygon offsets, the same circle of confusion
// as Classic 3D).
//
// Spec 19 §9 adds a second pipeline to the same passes. A scene with physically based surfaces, models, tone mapping,
// exposure, glints, supersampling or an environment preset or HDR draws in scene-linear light on a multisampled RGBA16F
// target (`hdr-passes.ts`), or refuses with THREE_D_NEEDS_FLOAT. It shades with metal-roughness GGX, image-based light
// from a prefiltered environment, clearcoat, flakes, procedural normals, thin-film iridescence and transmission, and
// tone maps only what it drew, never the backdrop. Everything else stays on the 8-bit path, pixel for pixel.
import {
	ADVANCED_MAX_LIGHTS,
	ADVANCED_MAX_SHADOW_TILES,
	advancedSupersampling,
	basisView,
	type CameraState,
	type ClassicSetup,
	circleOfConfusion,
	GLSL_COLOR,
	GLSL_HASH,
	GLSL_UV,
	type GlintState,
	type LightState,
	MAX_DOF_RADIUS,
	MAX_SLOTS,
	type MaterialState,
	type Matrix4,
	type Mesh,
	type ModelMaterial,
	mat4Apply,
	mat4Invert,
	mat4Mul,
	resolveIncludes,
	type SurfaceState,
	THREE_D_FLOAT_MESSAGE,
	THREE_D_NEEDS_FLOAT,
	type ToneMapping,
	type Vec3,
} from '@jasper/project';
import { blit, compileShader, ensureCanvas, type FxHost } from '../fx/host.ts';
import {
	buildEnvMaps,
	composite,
	downsample,
	ENV_ROUGHNESS,
	type EnvMaps,
	type EnvSource,
	expandResolved,
	HDR_SHOULDER_GLSL,
	type HdrKit,
	renderGlint,
	TONE_MODE,
} from './hdr-passes.ts';
import type { LoadedModel } from './model-loader.ts';

export type AdvancedMember = {
	key: string;
	picture: TexImageSource;
	pictureWidth: number;
	pictureHeight: number;
	/** Layer px → picture px (row-major 3×3, projective with a corner pin). */
	layerToPicture: readonly number[];
	/** Layer → world (row-major 4×4). */
	world: Matrix4;
	/** Extruded solid (layer px), or null for a flat layer. */
	mesh: Mesh | null;
	/** A 3D model layer: its model (drawn instead of the picture; `world` then maps model units → world). */
	model?: LoadedModel | null;
	material: MaterialState;
	/** Surfaces per mesh slot (`layerSurfacesAt`); a null slot, or none, shades with Material Options. */
	surfaces?: readonly (SurfaceState | null)[];
	opacity: number;
	/** Drawn (false: Casts Shadows "Only"). */
	draw: boolean;
};

export type AdvancedEnvironment = {
	/** An 8-bit picture, as `<img>` decodes it. */
	image?: TexImageSource;
	/** What to prefilter (spec 19 TL-075), and the key its maps are cached by. Absent: `image` on the 8-bit path. */
	source?: EnvSource;
	key?: string;
	/** Radians about the vertical axis. */
	rotation: number;
	/** Colour × intensity. */
	color: Vec3;
	background: boolean;
};

/** After shading: spec 19 TL-076, TL-077. */
export type AdvancedLook = {
	toneMapping: ToneMapping;
	/** Linear multiplier. */
	exposure: number;
	glint: GlintState | null;
	/** Render size per axis. */
	supersampling: number;
};

export type AdvancedInput = {
	setup: ClassicSetup;
	members: AdvancedMember[];
	backdrop: TexImageSource | null;
	environment: AdvancedEnvironment | null;
	/** Shadow map size (texels per side). */
	shadowMapSize: number;
	look?: AdvancedLook;
};

const LIGHT_TEXELS = 6;
/** Texels per surface in the material table. */
const MAT_TEXELS = 8;
/** Entries of a tint ramp. */
const RAMP_SIZE = 256;
/** Sequence px of a feature that still counts as a point for glint rays. */
const GLINT_DETAIL = 6;

const FX_GLSL = resolveIncludes([GLSL_HASH, GLSL_UV, GLSL_COLOR])
	.map((c) => c.source)
	.join('\n');

const ENV_LEVEL_GLSL = /* glsl */ `
const float ENV_R[${ENV_ROUGHNESS.length}] = float[${ENV_ROUGHNESS.length}](${ENV_ROUGHNESS.map((r) => r.toFixed(3)).join(', ')});
float envLevel(float r) {
  for (int k = 1; k < ${ENV_ROUGHNESS.length}; k++)
    if (r <= ENV_R[k]) return float(k - 1) + (r - ENV_R[k - 1]) / (ENV_R[k] - ENV_R[k - 1]);
  return ${(ENV_ROUGHNESS.length - 1).toFixed(1)};
}
`;

// Procedural normals of a surface (crumpled foil, hammered, liquid): Pachislop's `materials.ts`, on the integer hashes of
// fx/hash where it used float hashes. Layer px, so a relief is the same at every resolution; the antialiasing width is
// the pixel footprint in features, computed from depth: derivatives of a varying are unstable on the sliver triangles
// of a glyph's cap.
const RELIEF_GLSL = /* glsl */ `
float rlSeed(float s) { return fract(s * 0.61803398875); }
float rlNoise(vec2 p, float seed) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(fx_hash22(i, seed) * 2.0 - 1.0, f);
  float b = dot(fx_hash22(i + ivec2(1, 0), seed) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(fx_hash22(i + ivec2(0, 1), seed) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(fx_hash22(i + ivec2(1, 1), seed) * 2.0 - 1.0, f - vec2(1.0));
  return 2.0 * (a + u.x * (b - a) + u.y * (c - a) + u.x * u.y * (a - b - c + d));
}
float rlLiquid(vec2 p, float seed) {
  vec2 w = vec2(rlNoise(p * 0.5, seed), rlNoise(p * 0.5 + vec2(5.2, 1.3), seed));
  vec2 q = p + 0.9 * w;
  return rlNoise(q, seed) + 0.3 * rlNoise(q * 2.03 + vec2(1.7, 9.2), seed);
}
vec2 rlCellSlope(vec2 v, ivec2 cell, int kind, float seed) {
  vec2 r = fx_hash22(cell + ivec2(17, 41), seed);
  if (kind == 1) return r * 2.0 - 1.0;
  return v * (1.0 + 0.5 * r.x);
}
vec2 rlCells(vec2 p, float aa, int kind, float seed) {
  ivec2 c = ivec2(floor(p));
  float d1 = 1e9;
  float d2 = 1e9;
  vec2 v1 = vec2(0.0);
  vec2 v2 = vec2(0.0);
  ivec2 g1 = c;
  ivec2 g2 = c;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      ivec2 g = c + ivec2(i, j);
      vec2 v = p - vec2(g) - fx_hash22(g, seed) * 0.9;
      float d = dot(v, v);
      if (d < d1) { d2 = d1; v2 = v1; g2 = g1; d1 = d; v1 = v; g1 = g; }
      else if (d < d2) { d2 = d; v2 = v; g2 = g; }
    }
  float edge = (d2 - d1) / max(2.0 * length(v2 - v1), 1e-4);
  float w = 0.5 + 0.5 * smoothstep(0.0, aa, edge);
  return mix(rlCellSlope(v2, g2, kind, seed), rlCellSlope(v1, g1, kind, seed), w);
}
float reliefTilt(int kind) { return kind == 1 ? 0.45 : kind == 2 ? 0.4 : 0.22; }
vec2 reliefSlope(vec2 pos, int kind, float scale, float seed, float aa) {
  vec2 p = pos / max(scale, 1e-3);
  float s = rlSeed(seed);
  if (kind == 3) {
    const float e = 0.02;
    float h = rlLiquid(p, s);
    return vec2(rlLiquid(p + vec2(e, 0.0), s) - h, rlLiquid(p + vec2(0.0, e), s) - h) / e;
  }
  if (kind == 1) return rlCells(p, aa, 1, s) + 0.5 * rlCells(mat2(0.8, -0.6, 0.6, 0.8) * p * 2.3 + 7.1, aa * 2.3, 1, s);
  return rlCells(p, aa, 2, s);
}
`;

const MESH_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
layout(location = 3) in float a_kind;
uniform mat4 u_world;
uniform mat3 u_normalMat;
uniform mat4 u_viewProj;
out vec3 v_world;
out vec3 v_normal;
out vec2 v_uv;
out float v_kind;
out vec3 v_layer;
void main() {
  vec4 w = u_world * vec4(a_pos, 1.0);
  v_world = w.xyz;
  v_normal = u_normalMat * a_normal;
  v_uv = a_uv;
  v_kind = a_kind;
  v_layer = a_pos;
  gl_Position = u_viewProj * w;
}
`;

/** Colour of a fragment: the picture at the layer point (faces), the opaque fill colour (walls). */
const SURFACE = `
uniform sampler2D u_pic;
uniform mat3 u_l2p;
uniform vec2 u_picSize;
uniform float u_opacity;
uniform int u_solid;
uniform int u_model;
uniform vec4 u_baseColor;
uniform sampler2D u_baseTex;
uniform int u_hasBaseTex;
uniform int u_alphaMode;
uniform float u_alphaCutoff;
vec4 surface(vec2 uv, float kind) {
  if (u_model == 1) {
    // Linear: base colour factors are, and base colour textures are read through sRGB texture formats.
    vec4 c = u_baseColor * (u_hasBaseTex == 1 ? texture(u_baseTex, uv) : vec4(1.0));
    float ma = u_alphaMode == 2 ? c.a : (u_alphaMode == 1 ? step(u_alphaCutoff, c.a) : 1.0);
    return vec4(clamp(c.rgb, 0.0, 1.0), ma * u_opacity);
  }
  vec3 q = u_l2p * vec3(uv, 1.0);
  vec2 pp = q.xy / q.z;
  vec2 tc = pp / u_picSize;
  vec4 t = (tc.x < 0.0 || tc.y < 0.0 || tc.x > 1.0 || tc.y > 1.0) ? vec4(0.0) : texture(u_pic, tc);
  vec3 rgb = t.a > 1e-4 ? clamp(t.rgb / t.a, 0.0, 1.0) : vec3(0.0);
  float a = (u_solid == 1 || kind > 0.5) ? 1.0 : t.a;
  return vec4(rgb, a * u_opacity);
}
`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_normal;
in vec2 v_uv;
in float v_kind;
${SURFACE}
out vec4 o;
void main() {
  if (surface(v_uv, v_kind).a < 0.5) discard;
  o = vec4(1.0);
}
`;

const MAIN_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec3 v_world;
in vec3 v_normal;
in vec2 v_uv;
in float v_kind;
in vec3 v_layer;
${SURFACE}
uniform int u_pass;
uniform int u_hdr;
uniform vec3 u_eye;
uniform vec3 u_fwd;
uniform int u_ortho;
uniform int u_lit;
uniform sampler2D u_lights;
uniform int u_lightCount;
uniform vec4 u_m0; // ambient, diffuse, specular, shininess
uniform vec4 u_m1; // metal, reflection, reflectionSharpness, acceptsShadows
uniform highp sampler2D u_shadowAtlas;
uniform sampler2D u_tiles;
uniform vec3 u_atlas; // tile size, columns, atlas size
uniform sampler2D u_env;
uniform int u_hasEnv;
uniform vec4 u_envColor; // rgb, rotation
uniform float u_envLod;
uniform vec2 u_mr; // model: metallic, roughness
uniform vec3 u_emissive;
uniform sampler2D u_irr;
uniform sampler2D u_mats;
uniform int u_matBase;
uniform sampler2D u_ramps;
uniform float u_rampRows;
uniform vec4 u_bounds; // layer px of the solid
uniform vec3 u_axisX; // the layer's x and y in world space
uniform vec3 u_axisY;
uniform float u_exposure;
uniform sampler2D u_transBack;
uniform mat4 u_viewProj;
uniform vec2 u_targetSize;
uniform float u_zoomPx; // output px per world unit at distance 1
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 o1;
const float PI = 3.14159265;
${FX_GLSL}
${HDR_SHOULDER_GLSL}
${ENV_LEVEL_GLSL}
${RELIEF_GLSL}
vec4 L(int l, int k) { return texelFetch(u_lights, ivec2(k, l), 0); }
vec4 T(int t, int k) { return texelFetch(u_tiles, ivec2(k, t), 0); }
vec4 toLight(int l, vec3 p) {
  if (int(L(l, 0).x) == 1) return vec4(-L(l, 2).xyz, -1.0);
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
/** Fraction of light l reaching p (1 = lit) from its shadow map tiles (PCF over Shadow Diffusion). */
float lit(int l, vec3 p, vec3 n) {
  vec4 t0 = L(l, 0);
  if (t0.z < 0.5 || t0.w < 0.0) return 1.0;
  int first = int(t0.w);
  int tile = first;
  if (int(t0.x) == 2) {
    vec3 d = p - L(l, 1).xyz;
    vec3 a = abs(d);
    int face = a.x >= a.y && a.x >= a.z ? (d.x > 0.0 ? 0 : 1) : a.y >= a.z ? (d.y > 0.0 ? 2 : 3) : (d.z > 0.0 ? 4 : 5);
    tile = first + face;
  }
  mat4 vp = mat4(T(tile, 0), T(tile, 1), T(tile, 2), T(tile, 3));
  vec4 info = T(tile, 4); // texel world size (at distance 1 for perspective tiles), perspective flag
  vec4 c = vp * vec4(p, 1.0);
  if (c.w <= 0.0) return 1.0;
  vec3 ndc = c.xyz / c.w;
  if (any(greaterThan(abs(ndc.xy), vec2(1.0))) || ndc.z > 1.0) return 1.0;
  float size = u_atlas.x;
  float cols = u_atlas.y;
  vec2 origin = vec2(mod(float(tile), cols), floor(float(tile) / cols)) * size;
  vec2 pix = origin + (ndc.xy * 0.5 + 0.5) * size;
  float depth = ndc.z * 0.5 + 0.5;
  vec4 tl = toLight(l, p);
  float dist = tl.w < 0.0 ? 1.0 : tl.w;
  float texelWorld = info.x * (info.y > 0.5 ? dist : 1.0);
  float r = clamp(L(l, 5).y / max(texelWorld, 1e-6), 0.0, 6.0);
  float slope = 1.0 - abs(dot(n, tl.xyz));
  float bias = (1.5 + 3.0 * slope) / 16777216.0 * 64.0;
  float sum = 0.0;
  float cnt = 0.0;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      vec2 q = clamp(pix + vec2(float(i), float(j)) * max(r, 0.5) * 0.5, origin + 0.5, origin + size - 0.5);
      float sd = texelFetch(u_shadowAtlas, ivec2(q), 0).r;
      sum += depth - bias <= sd ? 1.0 : 0.0;
      cnt += 1.0;
    }
  return sum / cnt;
}
vec2 envUV(vec3 d) {
  float lat = asin(clamp(-d.y, -1.0, 1.0));
  float lon = atan(d.x, d.z) + u_envColor.w;
  return vec2(fract(0.5 + lon / (2.0 * PI)), 0.5 - lat / PI);
}
vec3 envAt(vec3 d, float lod) { return textureLod(u_env, envUV(normalize(d)), lod).rgb * u_envColor.rgb; }
vec4 M(int k) { return texelFetch(u_mats, ivec2(k, u_matBase + int(v_kind + 0.5)), 0); }
vec3 envSpec(vec3 d, float rough) { return textureLod(u_env, envUV(normalize(d)), envLevel(rough)).rgb * u_envColor.rgb; }
vec3 envIrr(vec3 d) { return texture(u_irr, envUV(normalize(d))).rgb * u_envColor.rgb; }
// Split-sum environment BRDF, the analytic fit of Karis, "Physically Based Shading on Mobile" (2014).
vec2 envBrdf(float rough, float nv) {
  vec4 r = rough * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float a004 = min(r.x * r.x, exp(-9.28 * nv * 0.6931472)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}
// A thin film in air: two-beam interference (Born and Wolf) at three wavelengths. Not Belcour and Barla's full spectral
// integration: this is the common approximation, and it stays continuous in angle and thickness.
vec3 thinFilm(float cosI, float nm) {
  const float n = 1.33;
  float sinT2 = (1.0 - cosI * cosI) / (n * n);
  float cosT = sqrt(max(1.0 - sinT2, 0.0));
  vec3 phase = 2.0 * PI * (2.0 * n * nm * cosT) / vec3(650.0, 532.0, 450.0);
  return 0.5 - 0.5 * cos(phase);
}
vec4 finish(vec3 premult, float a) {
  if (u_hdr == 1) premult = hdrCompress(premult, a, u_exposure);
  return vec4(premult, a);
}
float ggx(float nh, float nl, float nv, float al) {
  float a2 = al * al;
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float V = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2));
  return D * V * PI * nl;
}
vec3 fresnel(vec3 f0, float c) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }
void shadePhysical(vec4 s, vec3 p, vec3 view, vec3 geo, bool model) {
  int acceptsShadows = int(u_m1.w);
  vec4 t0 = M(0);
  vec4 t1 = M(1);
  vec4 t2 = M(2);
  vec4 t3 = M(3);
  vec4 t4 = M(4);
  vec4 t5 = M(5);
  vec4 t6 = M(6);
  vec4 t7 = M(7);
  vec3 rgb = s.rgb;
  float a = s.a;
  float metal = model ? u_mr.x : t1.x;
  float rough = clamp(model ? u_mr.y : t1.y, 0.0, 1.0);
  float reflectivity = model ? 1.0 : t1.z;
  float specBoost = model ? 1.0 : t1.w;
  if (!model) {
    if (t0.w > 0.5) rgb = t0.rgb;
    else rgb = fx_srgbToLinear(rgb);
    if (t4.z >= 0.0) {
      vec2 dir = vec2(cos(t4.w), sin(t4.w));
      vec2 c = 0.5 * (u_bounds.xy + u_bounds.zw);
      vec2 hs = max(0.5 * (u_bounds.zw - u_bounds.xy), vec2(1e-3));
      float ext = max(abs(dir.x) * hs.x + abs(dir.y) * hs.y, 1e-3);
      float t = clamp(0.5 + 0.5 * dot(v_layer.xy - c, dir) / ext, 0.0, 1.0);
      rgb = fx_srgbToLinear(texture(u_ramps, vec2(t, (t4.z + 0.5) / u_rampRows)).rgb);
    }
  }
  float footprint = (u_ortho == 1 ? 1.0 : max(dot(p - u_eye, u_fwd), 1.0)) / max(u_zoomPx, 1e-3);
  vec3 n = geo;
  // Procedural normals and flakes, projected front-on in layer space. The clearcoat stays smooth over them.
  if (!model) {
    if (t3.x > 0.5 && t3.y > 0.0) {
      vec2 slope = reliefSlope(v_layer.xy, int(t3.x + 0.5), t3.z, t3.w, footprint / max(t3.z, 1e-3));
      n -= (u_axisX * slope.x + u_axisY * slope.y) * t3.y * reliefTilt(int(t3.x + 0.5));
    }
    if (t2.z > 0.0) {
      float cellPx = max(t2.w, 1e-3);
      ivec3 cell = ivec3(floor(v_layer / cellPx));
      vec3 r = fx_hash33(cell, 0.618034);
      // Cells under a pixel would alias: they fade into roughness instead.
      float keep = smoothstep(0.75, 2.5, cellPx / max(footprint, 1e-4));
      n += (u_axisX * (r.x - 0.5) + u_axisY * (r.y - 0.5)) * 1.1 * t2.z * keep;
      rough = clamp(rough + (1.0 - keep) * t2.z * 0.3, 0.0, 1.0);
    }
  }
  n = normalize(n);
  if (dot(n, view) < 0.02) n = normalize(n + view * (0.02 - dot(n, view)));
  float nv = max(dot(n, view), 1e-4);
  float ior = model ? 1.5 : t5.y;
  float ior0 = (ior - 1.0) / (ior + 1.0);
  vec3 f0 = mix(vec3(ior0 * ior0), rgb, metal);
  if (!model && t4.x > 0.0) f0 = mix(f0, thinFilm(nv, t4.y) * mix(vec3(1.0), rgb, metal), t4.x);
  float al = max(rough * rough, 0.0016);
  vec3 diff = vec3(0.0);
  vec3 amb = vec3(0.0);
  vec3 spec = vec3(0.0);
  vec3 coatSpec = vec3(0.0);
  float coat = model ? 0.0 : t2.x;
  float coatAl = model ? 1.0 : max(t2.y * t2.y, 0.0016);
  float shadowAmt = 0.0;
  for (int l = 0; l < u_lightCount; l++) {
    vec4 lt = L(l, 0);
    vec3 color = L(l, 3).xyz;
    if (int(lt.x) == 0) { amb += color; continue; }
    float k = attenuation(l, p);
    if (k <= 0.0) continue;
    vec3 lv = toLight(l, p).xyz;
    float nl = dot(n, lv);
    if (nl <= 0.0) continue;
    float sh = acceptsShadows != 0 ? lit(l, p, n) : 1.0;
    shadowAmt = max(shadowAmt, (1.0 - sh) * L(l, 5).x);
    float vis = mix(1.0, sh, L(l, 5).x);
    diff += color * (nl * k * vis);
    vec3 h = normalize(lv + view);
    float nh = max(dot(n, h), 0.0);
    float vh = max(dot(view, h), 0.0);
    spec += color * (ggx(nh, nl, nv, al) * k * vis) * fresnel(f0, vh);
    if (coat > 0.0) {
      float gnl = max(dot(geo, lv), 1e-4);
      float gnh = max(dot(geo, h), 0.0);
      coatSpec += color * (ggx(gnh, gnl, max(dot(geo, view), 1e-4), coatAl) * k * vis) * (0.04 + 0.96 * pow(1.0 - vh, 5.0));
    }
  }
  spec *= specBoost;
  coatSpec *= specBoost;
  vec3 refl = vec3(0.0);
  vec3 coatRefl = vec3(0.0);
  vec2 ab = envBrdf(rough, nv);
  vec3 envF = f0 * ab.x + ab.y;
  if (u_hasEnv == 1) {
    diff += envIrr(n);
    refl = envSpec(reflect(-view, n), rough) * envF * reflectivity;
    if (coat > 0.0) coatRefl = envSpec(reflect(-view, geo), sqrt(coatAl)) * reflectivity;
  }
  if (acceptsShadows == 2) {
    float sa = shadowAmt * a;
    if (sa <= 0.002) discard;
    o = finish(vec3(0.0), sa);
    return;
  }
  float coatF = coat * (0.04 + 0.96 * pow(1.0 - max(dot(geo, view), 0.0), 5.0));
  float ambW = model ? u_m0.x : 1.0;
  float diffW = model ? u_m0.y : 1.0;
  float trans = model ? 0.0 : t5.x;
  vec3 body = rgb * (1.0 - metal) * (ambW * amb + diffW * diff);
  vec3 glossy = spec + refl + (model ? u_emissive : t7.rgb);
  // The base layers under the coat lose what the coat reflects.
  vec3 c = (body * (1.0 - trans) * a + glossy) * (1.0 - coatF) + coatSpec * coat + coatRefl * coatF;
  if (u_pass == 2) {
    // Refract through the solid: the ray enters here and leaves a thickness further along, and reads what lies behind
    // at that screen position (the opaque scene over the sequence's backdrop). Dispersion spreads the three channels.
    float spread = (ior - 1.0) * 0.025 * t5.w * 3.0;
    vec3 iors = vec3(ior - spread, ior, ior + spread);
    float lodR = rough * clamp(ior * 2.0 - 2.0, 0.0, 1.0);
    float lod = log2(max(u_targetSize.x, 1.0)) * lodR;
    vec3 back = vec3(0.0);
    for (int k = 0; k < 3; k++) {
      vec3 dir = refract(-view, n, 1.0 / iors[k]);
      if (dot(dir, dir) < 1e-6) dir = -view;
      vec4 clip = u_viewProj * vec4(p + dir * t5.z, 1.0);
      vec2 uv = clamp(clip.xy / max(clip.w, 1e-3) * 0.5 + 0.5, vec2(0.0), vec2(1.0));
      back[k] = textureLod(u_transBack, uv, lod)[k];
    }
    vec3 tint = rgb * t6.rgb * (1.0 - metal);
    vec3 through = back * tint * (1.0 - clamp(envF, 0.0, 1.0)) * trans * (1.0 - coatF);
    float body01 = (1.0 - trans) * a;
    // Highlights stay solid on glass over nothing.
    float glow = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
    o = finish(c, body01 + (1.0 - body01) * glow);
    o1 = vec4(through, trans * a);
    return;
  }
  o = finish(c, a);
}
void main() {
  vec4 s = surface(v_uv, v_kind);
  o1 = vec4(0.0);
  bool phys = u_hdr == 1 && (u_model == 1 || M(6).w > 0.5);
  float trans = u_hdr == 1 && u_model == 0 ? M(5).x : 0.0;
  if (u_pass == 2) {
    if (trans <= 0.001 || s.a < 0.5) discard;
  } else {
    if (trans > 0.001) discard;
    if (u_pass == 0 && s.a < 0.999) discard;
    if (u_pass == 1 && (s.a >= 0.999 || s.a < 0.002)) discard;
  }
  vec3 rgb = s.rgb;
  float a = s.a;
  int acceptsShadows = int(u_m1.w);
  if (u_lit == 0) {
    if (acceptsShadows == 2) discard;
    if (u_hdr == 1 && u_model == 0) rgb = fx_srgbToLinear(rgb);
    o = finish(rgb * a, a);
    return;
  }
  vec3 p = v_world;
  vec3 view = u_ortho == 1 ? -u_fwd : normalize(u_eye - p);
  vec3 n = normalize(v_normal);
  if (dot(n, view) < 0.0) n = -n;
  if (phys) {
    shadePhysical(s, p, view, n, u_model == 1);
    return;
  }
  if (u_hdr == 1) rgb = fx_srgbToLinear(rgb);
  float nv = max(dot(n, view), 1e-4);
  float rough = clamp(1.0 - u_m0.w, 0.04, 1.0);
  float al = rough * rough;
  vec3 f0 = vec3(0.04 * u_m0.z / 0.5) * mix(vec3(1.0), rgb, u_m1.x);
  vec3 amb = vec3(0.0);
  vec3 diff = vec3(0.0);
  vec3 spec = vec3(0.0);
  vec3 refl = vec3(0.0);
  float shadowAmt = 0.0;
  for (int l = 0; l < u_lightCount; l++) {
    vec4 lt = L(l, 0);
    vec3 color = L(l, 3).xyz;
    if (int(lt.x) == 0) { amb += color; continue; }
    float k = attenuation(l, p);
    if (k <= 0.0) continue;
    vec3 lv = toLight(l, p).xyz;
    float nl = dot(n, lv);
    if (nl <= 0.0) continue;
    float sh = acceptsShadows != 0 ? lit(l, p, n) : 1.0;
    shadowAmt = max(shadowAmt, (1.0 - sh) * L(l, 5).x);
    float vis = mix(1.0, sh, L(l, 5).x);
    diff += color * (nl * k * vis);
    vec3 h = normalize(lv + view);
    float nh = max(dot(n, h), 0.0);
    float vh = max(dot(view, h), 0.0);
    float a2 = al * al;
    float dd = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float V = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2));
    vec3 F = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
    spec += color * (D * V * PI * nl * k * vis) * F;
  }
  if (u_hasEnv == 1) {
    diff += u_hdr == 1 ? envIrr(n) : envAt(n, u_envLod - 1.0);
    if (u_m1.y > 0.0) {
      vec3 r = reflect(-view, n);
      vec3 fr = vec3(u_m1.y) + (1.0 - vec3(u_m1.y)) * pow(1.0 - nv, 5.0) * u_m1.y;
      vec3 e = u_hdr == 1 ? envSpec(r, 1.0 - u_m1.z) : envAt(r, (1.0 - u_m1.z) * u_envLod);
      refl += e * fr * mix(vec3(1.0), rgb, u_m1.x);
    }
  }
  if (acceptsShadows == 2) {
    float sa = shadowAmt * a;
    if (sa <= 0.002) discard;
    o = finish(vec3(0.0), sa);
    return;
  }
  vec3 c = rgb * (u_m0.x * amb + u_m0.y * diff) * (1.0 - u_m1.y) + spec * (u_m0.z > 0.0 ? 1.0 : 0.0) + refl;
  o = finish(c * a, a);
}
`;

const FULL_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_ndc;
void main() { v_ndc = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/** The backdrop (premultiplied, top row first) or the environment as the background. */
const BACK_FS = `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_back;
uniform int u_mode; // 0 backdrop, 1 environment
uniform mat4 u_invViewProj;
uniform vec3 u_eye;
uniform vec3 u_fwd;
uniform int u_ortho;
uniform sampler2D u_env;
uniform vec4 u_envColor;
uniform float u_exposure;
uniform int u_hdr;
out vec4 o;
const float PI = 3.14159265;
${HDR_SHOULDER_GLSL}
void main() {
  if (u_mode == 0) {
    vec2 uv = vec2(v_ndc.x * 0.5 + 0.5, 0.5 - v_ndc.y * 0.5);
    o = texture(u_back, uv);
    return;
  }
  vec4 far = u_invViewProj * vec4(v_ndc, 1.0, 1.0);
  vec3 d = u_ortho == 1 ? u_fwd : normalize(far.xyz / far.w - u_eye);
  float lat = asin(clamp(-d.y, -1.0, 1.0));
  float lon = atan(d.x, d.z) + u_envColor.w;
  vec3 c = textureLod(u_env, vec2(fract(0.5 + lon / (2.0 * PI)), 0.5 - lat / PI), 0.0).rgb * u_envColor.rgb;
  o = vec4(u_hdr == 1 ? hdrCompress(c, 1.0, u_exposure) : c, 1.0);
}
`;

/** View depth of the nearest surface (alpha ≥ 0.5), for the depth of field. */
const DEPTH_FS = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_normal;
in vec2 v_uv;
in float v_kind;
${SURFACE}
uniform vec3 u_eye;
uniform vec3 u_fwd;
out vec4 o;
void main() {
  if (surface(v_uv, v_kind).a < 0.5) discard;
  o = vec4(dot(v_world - u_eye, u_fwd), 0.0, 0.0, 1.0);
}
`;

const DOF_FS = `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_color;
uniform sampler2D u_depth;
uniform vec2 u_size;
uniform vec4 u_dof; // aperture, focus, blurLevel, scale
uniform float u_maxR;
uniform vec2 u_taps[96];
uniform int u_tapCount;
out vec4 o;
float coc(float z) {
  if (z <= 1.0 || u_dof.y <= 0.0) return 0.0;
  return min(u_maxR, u_dof.x * abs(z - u_dof.y) / z * u_dof.z * u_dof.w);
}
void main() {
  vec2 px = gl_FragCoord.xy;
  float z0 = texelFetch(u_depth, ivec2(px), 0).r;
  float c0 = z0 > 0.0 ? coc(z0) : 0.0;
  vec4 sum = texelFetch(u_color, ivec2(px), 0);
  float wsum = 1.0;
  for (int i = 0; i < 96; i++) {
    if (i >= u_tapCount) break;
    vec2 off = u_taps[i] * u_maxR;
    vec2 q = px + off;
    if (q.x < 0.0 || q.y < 0.0 || q.x >= u_size.x || q.y >= u_size.y) continue;
    float zk = texelFetch(u_depth, ivec2(q), 0).r;
    float ck = zk > 0.0 ? coc(zk) : 0.0;
    float reach = (zk > z0 && z0 > 0.0) ? min(ck, c0) : (z0 <= 0.0 ? ck : max(ck, c0 * step(zk, z0)));
    float d = length(off);
    float w = clamp(reach - d + 0.5, 0.0, 1.0);
    sum += texelFetch(u_color, ivec2(q), 0) * w;
    wsum += w;
  }
  o = sum / wsum;
}
`;

type GpuMesh = {
	vao: WebGLVertexArrayObject;
	buffers: WebGLBuffer[];
	bounds: [number, number, number, number];
	used: number;
};

type Progs = {
	shadow: WebGLProgram;
	main: WebGLProgram;
	depth: WebGLProgram;
	back: WebGLProgram;
	dof: WebGLProgram;
	locs: Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>;
	tex: Map<string, WebGLTexture & { __key?: string }>;
	rb: Map<string, WebGLRenderbuffer & { __key?: string }>;
	fbo: WebGLFramebuffer;
	fbo2: WebGLFramebuffer;
	shadowFbo: WebGLFramebuffer;
	quad: WebGLBuffer;
	quadVao: WebGLVertexArrayObject;
	/** GPU copies of solids, kept while the geometry does not change: a moving camera uploads nothing. */
	meshes: Map<Mesh, GpuMesh>;
	/** sRGB textures of model base colour images. */
	modelTex: Map<ImageBitmap, WebGLTexture>;
	/** Interleaved vertices of model primitives. */
	primMeshes: WeakMap<object, Mesh>;
	envs: Map<string, EnvMaps>;
	hdrProgs: Map<string, WebGLProgram>;
	kit: HdrKit | null;
	frame: number;
};
const cache = new WeakMap<WebGL2RenderingContext, Progs>();

/** Solids kept on the GPU, and how many frames one may go unused. */
const MAX_GPU_MESHES = 48;
const GPU_MESH_FRAMES = 300;
/** Environments kept prefiltered. */
const MAX_ENVS = 6;
const MAX_MODEL_TEXTURES = 64;

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string, label: string): WebGLProgram {
	const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
	if (typeof vs === 'string') throw new Error(`WEBGL_UNAVAILABLE: Advanced 3D ${label} vertex shader: ${vs}`);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
	if (typeof fs === 'string') throw new Error(`WEBGL_UNAVAILABLE: Advanced 3D ${label} shader: ${fs}`);
	const p = gl.createProgram()!;
	gl.attachShader(p, vs);
	gl.attachShader(p, fs);
	gl.bindAttribLocation(p, 0, 'a_pos');
	gl.linkProgram(p);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
		throw new Error(`WEBGL_UNAVAILABLE: Advanced 3D ${label} link: ${gl.getProgramInfoLog(p) ?? ''}`);
	return p;
}

function progs(gl: WebGL2RenderingContext): Progs {
	let p = cache.get(gl);
	if (p) return p;
	const quad = gl.createBuffer()!;
	gl.bindBuffer(gl.ARRAY_BUFFER, quad);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	const quadVao = gl.createVertexArray()!;
	gl.bindVertexArray(quadVao);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	gl.bindBuffer(gl.ARRAY_BUFFER, null);
	p = {
		shadow: link(gl, MESH_VS, SHADOW_FS, 'shadow'),
		main: link(gl, MESH_VS, MAIN_FS, 'surface'),
		depth: link(gl, MESH_VS, DEPTH_FS, 'depth'),
		back: link(gl, FULL_VS, BACK_FS, 'background'),
		dof: link(gl, FULL_VS, DOF_FS, 'depth of field'),
		locs: new Map(),
		tex: new Map(),
		rb: new Map(),
		fbo: gl.createFramebuffer()!,
		fbo2: gl.createFramebuffer()!,
		shadowFbo: gl.createFramebuffer()!,
		quad,
		quadVao,
		meshes: new Map(),
		modelTex: new Map(),
		primMeshes: new WeakMap(),
		envs: new Map(),
		hdrProgs: new Map(),
		kit: null,
		frame: 0,
	};
	cache.set(gl, p);
	return p;
}

function kitOf(gl: WebGL2RenderingContext, ps: Progs): HdrKit {
	if (ps.kit) return ps.kit;
	const vertex = FULL_VS;
	ps.kit = {
		gl,
		fbo: ps.fbo2,
		quad: ps.quadVao,
		target: (name, w, h, mips = 1) => tex2d(gl, ps, name, w, h, 'rgba16f', mips),
		program: (key, fragment) => {
			let p = ps.hdrProgs.get(key);
			if (!p) {
				p = link(gl, vertex, fragment, key);
				ps.hdrProgs.set(key, p);
			}
			return p;
		},
		uniform: (prog, name) => U(gl, ps, prog, name),
	};
	return ps.kit;
}

function U(
	gl: WebGL2RenderingContext,
	ps: Progs,
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

type TexFmt = 'rgba8' | 'r32f' | 'rgba32f' | 'rgba16f' | 'depth24';
function tex2d(
	gl: WebGL2RenderingContext,
	ps: Progs,
	name: string,
	w: number,
	h: number,
	fmt: TexFmt,
	mips = 1,
): WebGLTexture {
	const key = `${w}x${h}:${fmt}:${mips}`;
	let t = ps.tex.get(name);
	if (t && t.__key === key) return t;
	if (t) gl.deleteTexture(t);
	t = gl.createTexture()! as WebGLTexture & { __key?: string };
	gl.bindTexture(gl.TEXTURE_2D, t);
	const filter = fmt === 'rgba8' || fmt === 'rgba16f' ? gl.LINEAR : gl.NEAREST;
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips > 1 ? gl.LINEAR_MIPMAP_LINEAR : filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	if (fmt === 'rgba16f') gl.texStorage2D(gl.TEXTURE_2D, mips, gl.RGBA16F, w, h);
	else if (fmt === 'rgba8')
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	else if (fmt === 'r32f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
	else if (fmt === 'rgba32f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
	else
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
	t.__key = key;
	ps.tex.set(name, t);
	return t;
}

function renderbuffer(
	gl: WebGL2RenderingContext,
	ps: Progs,
	name: string,
	w: number,
	h: number,
	fmt: number,
	samples: number,
): WebGLRenderbuffer {
	const key = `${w}x${h}:${fmt}:${samples}`;
	let r = ps.rb.get(name);
	if (r && r.__key === key) return r;
	if (r) gl.deleteRenderbuffer(r);
	r = gl.createRenderbuffer()! as WebGLRenderbuffer & { __key?: string };
	gl.bindRenderbuffer(gl.RENDERBUFFER, r);
	gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, w, h);
	r.__key = key;
	ps.rb.set(name, r);
	return r;
}

function uploadPicture(gl: WebGL2RenderingContext, t: WebGLTexture, src: TexImageSource): void {
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
	gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

const invert3 = (m: readonly number[]): number[] | null => {
	const [a, b, c, d, e, f, g, h, i] = m as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (Math.abs(det) < 1e-300) return null;
	const k = 1 / det;
	return [
		A * k,
		-(b * i - c * h) * k,
		(b * f - c * e) * k,
		B * k,
		(a * i - c * g) * k,
		-(a * f - c * d) * k,
		C * k,
		-(a * h - b * g) * k,
		(a * e - b * d) * k,
	];
};

/** The layer quad covering the picture (layer px), as a mesh. */
export function pictureQuad(
	m: Pick<AdvancedMember, 'layerToPicture' | 'pictureWidth' | 'pictureHeight'>,
): Mesh | null {
	const inv = invert3(m.layerToPicture);
	if (!inv) return null;
	const corners = [
		[0, 0],
		[m.pictureWidth, 0],
		[m.pictureWidth, m.pictureHeight],
		[0, m.pictureHeight],
	].map(([x, y]) => {
		const X = inv[0]! * x! + inv[1]! * y! + inv[2]!;
		const Y = inv[3]! * x! + inv[4]! * y! + inv[5]!;
		const W = inv[6]! * x! + inv[7]! * y! + inv[8]!;
		return [X / W, Y / W] as [number, number];
	});
	if (!corners.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]))) return null;
	const v: number[] = [];
	for (const [x, y] of corners) v.push(x, y, 0, 0, 0, -1, x, y, 0);
	return { vertices: Float32Array.from(v), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]), stride: 9 };
}

/** Row-major 4×4 → the column-major array GL wants. */
const colMajor = (m: readonly number[]) =>
	new Float32Array([
		m[0]!,
		m[4]!,
		m[8]!,
		m[12]!,
		m[1]!,
		m[5]!,
		m[9]!,
		m[13]!,
		m[2]!,
		m[6]!,
		m[10]!,
		m[14]!,
		m[3]!,
		m[7]!,
		m[11]!,
		m[15]!,
	]);
const colMajor3 = (m: readonly number[]) =>
	new Float32Array([m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]);

/** Normal matrix (inverse transpose of the upper 3×3), row-major. */
function normalMatrix(w: Matrix4): number[] {
	const inv = invert3([w[0]!, w[1]!, w[2]!, w[4]!, w[5]!, w[6]!, w[8]!, w[9]!, w[10]!]) ?? [
		1, 0, 0, 0, 1, 0, 0, 0, 1,
	];
	return [inv[0]!, inv[3]!, inv[6]!, inv[1]!, inv[4]!, inv[7]!, inv[2]!, inv[5]!, inv[8]!];
}

/** Camera clip matrix (world → clip space; NDC y up = the top of the frame). */
export function cameraClip(
	cam: CameraState,
	frame: { width: number; height: number },
	near: number,
	far: number,
): Matrix4 {
	const W = frame.width;
	const H = frame.height;
	const P = cam.ortho
		? [
				(2 * cam.zoom) / W,
				0,
				0,
				0,
				0,
				(-2 * cam.zoom) / H,
				0,
				0,
				0,
				0,
				2 / (far - near),
				-(far + near) / (far - near),
				0,
				0,
				0,
				1,
			]
		: [
				(2 * cam.zoom) / W,
				0,
				0,
				0,
				0,
				(-2 * cam.zoom) / H,
				0,
				0,
				0,
				0,
				(far + near) / (far - near),
				(-2 * far * near) / (far - near),
				0,
				0,
				1,
				0,
			];
	return mat4Mul(P, cam.view);
}

type Prepared = {
	member: AdvancedMember;
	mesh: Mesh;
	centre: Vec3;
	vao: WebGLVertexArrayObject;
	/** Buffers to delete after the frame (picture quads; solids stay cached). */
	buffers: WebGLBuffer[];
	count: number;
	tex: WebGLTexture;
	bounds: [number, number, number, number];
	/** First row of this member's surfaces in the material table. */
	matBase: number;
	/** A model primitive: its material and base colour texture. */
	prim?: { material: ModelMaterial; tex: WebGLTexture | null };
};

const meshBounds = (m: Mesh): [number, number, number, number] => {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	const v = m.vertices;
	for (let i = 0; i + 8 < v.length; i += 9) {
		if (v[i]! < x0) x0 = v[i]!;
		if (v[i]! > x1) x1 = v[i]!;
		if (v[i + 1]! < y0) y0 = v[i + 1]!;
		if (v[i + 1]! > y1) y1 = v[i + 1]!;
	}
	return x1 >= x0 ? [x0, y0, x1, y1] : [0, 0, 1, 1];
};

const linearOf = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The material table: `MAT_TEXELS` floats × 4 per slot, see `shadePhysical`. */
function writeSurface(o: Float32Array, at: number, s: SurfaceState, rampRow: number): void {
	const b = s.baseColor;
	o.set([linearOf(b[0]), linearOf(b[1]), linearOf(b[2]), s.useColor ? 1 : 0], at);
	o.set([s.metalness, s.roughness, s.reflectivity, s.specularBoost], at + 4);
	o.set([s.clearcoat, s.clearcoatRoughness, s.flakes, s.flakeScale], at + 8);
	o.set([s.relief, s.reliefAmount, s.reliefScale, s.reliefSeed], at + 12);
	o.set([s.iridescence, s.iridescenceThickness, rampRow, ((s.ramp?.angle ?? 90) * Math.PI) / 180], at + 16);
	o.set([s.transmission, s.ior, s.thickness, s.dispersion], at + 20);
	const c = s.attenuationColor;
	o.set([linearOf(c[0]), linearOf(c[1]), linearOf(c[2]), 1], at + 24);
	const e = s.emissive;
	const k = s.emissiveIntensity;
	o.set([linearOf(e[0]) * k, linearOf(e[1]) * k, linearOf(e[2]) * k, 0], at + 28);
}

/** A tint ramp baked to `RAMP_SIZE` RGBA8 texels, in the signal as the stops are stored. */
function bakeRamp(s: NonNullable<SurfaceState['ramp']>, o: Uint8Array, at: number): void {
	const st = [...s.stops].sort((a, b) => a.at - b.at);
	for (let i = 0; i < RAMP_SIZE; i++) {
		const t = i / (RAMP_SIZE - 1);
		let k = 0;
		while (k < st.length - 2 && t > st[k + 1]!.at) k++;
		const a = st[k]!;
		const b = st[k + 1] ?? a;
		const f = b.at > a.at ? Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at))) : 0;
		for (let c = 0; c < 3; c++)
			o[at + i * 4 + c] = Math.round(
				Math.min(1, Math.max(0, a.color[c]! + (b.color[c]! - a.color[c]!) * f)) * 255,
			);
		o[at + i * 4 + 3] = 255;
	}
}

/** Interleaved vertices (position, normal, uv, kind) of a model primitive. */
function primitiveMesh(ps: Progs, p: LoadedModel['model']['primitives'][number]): Mesh {
	const hit = ps.primMeshes.get(p);
	if (hit) return hit;
	const n = p.positions.length / 3;
	const v = new Float32Array(n * 9);
	for (let i = 0; i < n; i++) {
		v.set(p.positions.subarray(i * 3, i * 3 + 3), i * 9);
		v.set(p.normals.subarray(i * 3, i * 3 + 3), i * 9 + 3);
		if (p.uvs) v.set(p.uvs.subarray(i * 2, i * 2 + 2), i * 9 + 6);
	}
	const mesh: Mesh = { vertices: v, indices: p.indices, stride: 9 };
	ps.primMeshes.set(p, mesh);
	return mesh;
}

function worldPoints(p: { member: AdvancedMember; mesh: Mesh }): Vec3[] {
	const out: Vec3[] = [];
	const v = p.mesh.vertices;
	const step = Math.max(1, Math.floor(v.length / 9 / 64));
	for (let i = 0; i < v.length / 9; i += step)
		out.push(mat4Apply(p.member.world, [v[i * 9]!, v[i * 9 + 1]!, v[i * 9 + 2]!]));
	return out;
}

/** Shadow tiles of a light: world → clip matrix, texel world size (at distance 1 when perspective), perspective. */
function shadowTiles(
	l: LightState,
	pts: readonly Vec3[],
	size: number,
): { vp: Matrix4; texel: number; persp: boolean }[] {
	if (pts.length === 0) return [];
	const c = pts.reduce(
		(a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length] as Vec3,
		[0, 0, 0] as Vec3,
	);
	const R = Math.max(1, ...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
	const persp = (eye: Vec3, fwd: Vec3, half: number): { vp: Matrix4; texel: number; persp: boolean } => {
		const view = basisView(eye, fwd, [0, 1, 0]);
		let far = 1;
		for (const p of pts) far = Math.max(far, mat4Apply(view, p)[2]);
		far *= 1.05;
		const near = Math.max(0.5, far / 20000);
		const f = 1 / Math.tan(half);
		const P = [
			f,
			0,
			0,
			0,
			0,
			f,
			0,
			0,
			0,
			0,
			(far + near) / (far - near),
			(-2 * far * near) / (far - near),
			0,
			0,
			1,
			0,
		];
		return { vp: mat4Mul(P, view), texel: (2 * Math.tan(half)) / size, persp: true };
	};
	if (l.type === 'spot') return [persp(l.pos, l.dir, Math.min(1.5, l.coneHalf * 1.05 + 0.02))];
	if (l.type === 'point') {
		const axes: Vec3[] = [
			[1, 0, 0],
			[-1, 0, 0],
			[0, 1, 0],
			[0, -1, 0],
			[0, 0, 1],
			[0, 0, -1],
		];
		// 90° faces, a little wider so PCF never reads across a face edge.
		return axes.map((a) => persp(l.pos, a, (Math.PI / 4) * 1.04));
	}
	// Parallel: orthographic over the scene's bounding sphere.
	const eye: Vec3 = [c[0] - l.dir[0] * R * 2, c[1] - l.dir[1] * R * 2, c[2] - l.dir[2] * R * 2];
	const view = basisView(eye, l.dir, [0, 1, 0]);
	const near = R;
	const far = R * 3.05;
	const s = 1 / R;
	const P = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, 2 / (far - near), -(far + near) / (far - near), 0, 0, 0, 1];
	return [{ vp: mat4Mul(P, view), texel: (2 * R) / size, persp: false }];
}

/** Unit-disc taps shaped by the iris (polygon with `sides`, rotated), rings of increasing radius. */
function irisTaps(sides: number, rotation: number, count: number): number[] {
	const out: number[] = [];
	const rings = 6;
	for (let r = 1; r <= rings && out.length / 2 < count; r++) {
		const rad = r / rings;
		const n = Math.min(count - out.length / 2, Math.round(6 * r * 1.33));
		for (let k = 0; k < n; k++) {
			const a = (k / n) * Math.PI * 2 + r * 0.37;
			let s = 1;
			if (sides >= 3) {
				// Distance to the polygon edge in direction a (unit circumradius).
				const seg = (Math.PI * 2) / sides;
				const rel = ((((a - rotation) % seg) + seg) % seg) - seg / 2;
				s = Math.cos(seg / 2) / Math.cos(rel);
			}
			out.push(Math.cos(a) * rad * s, Math.sin(a) * rad * s);
		}
	}
	return out;
}

/**
 * Renders a 3D run with Advanced 3D into `out` (the output size). Throws `WEBGL_UNAVAILABLE` on a lost context or a
 * missing capability.
 */
export function renderAdvancedGL(h: FxHost, input: AdvancedInput, out: CanvasRenderingContext2D): void {
	const { gl } = h;
	if (h.lost || gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the GPU context is lost');
	const ps = progs(gl);
	const { setup } = input;
	const W = Math.max(1, Math.round(setup.width));
	const H = Math.max(1, Math.round(setup.height));
	const cam = setup.camera;
	const draft = !!setup.draft;
	const lights = draft
		? []
		: setup.lights.filter((l) => l.type !== 'environment').slice(0, ADVANCED_MAX_LIGHTS);
	const look: AdvancedLook = input.look ?? {
		toneMapping: 'none',
		exposure: 1,
		glint: null,
		supersampling: 1,
	};
	const surfaced = input.members.some((m) => m.surfaces?.some((s) => !!s));
	const physical = surfaced || input.members.some((m) => m.model);
	const wantHdr =
		physical ||
		look.toneMapping !== 'none' ||
		look.exposure !== 1 ||
		!!look.glint ||
		look.supersampling > 1 ||
		!!input.environment?.source;
	if (wantHdr && !h.floatTargets) throw new Error(`${THREE_D_NEEDS_FLOAT}: ${THREE_D_FLOAT_MESSAGE}`);
	const hdr = wantHdr;
	// A physical surface with no environment light reflects the neutral studio: metal without one would be black. Models
	// do not: a model is lit by the sequence's lights, as it always was.
	const env: AdvancedEnvironment | null = draft
		? null
		: (input.environment ??
			(surfaced
				? {
						source: { kind: 'preset', preset: 0 },
						key: 'preset:0',
						rotation: 0,
						color: [1, 1, 1],
						background: false,
					}
				: null));
	const envSource: EnvSource | null = hdr
		? (env?.source ?? (env?.image ? { kind: 'image', image: env.image } : null))
		: null;
	const envKey = env?.key ?? null;
	const k = hdr
		? advancedSupersampling(look.supersampling, W, H, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number)
		: 1;
	const RW = W * k;
	const RH = H * k;
	ps.frame++;
	gl.disable(gl.SCISSOR_TEST);
	gl.disable(gl.CULL_FACE);
	gl.disable(gl.BLEND);

	// 1. geometry (VAOs), pictures and the material table
	const prepared: Prepared[] = [];
	/** A solid's VAO: kept while the mesh object lives, so a frame that only moves the camera uploads nothing. */
	const cached = (mesh: Mesh) => {
		let g = ps.meshes.get(mesh);
		if (!g) {
			const { vao, buffers } = upload(mesh, gl.STATIC_DRAW);
			g = { vao, buffers, bounds: meshBounds(mesh), used: ps.frame };
			ps.meshes.set(mesh, g);
		}
		g.used = ps.frame;
		return g;
	};
	const upload = (mesh: Mesh, usage: number = gl.STREAM_DRAW) => {
		const vao = gl.createVertexArray()!;
		gl.bindVertexArray(vao);
		const vb = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, vb);
		gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, usage);
		const S = 36;
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 12);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 2, gl.FLOAT, false, S, 24);
		gl.enableVertexAttribArray(3);
		gl.vertexAttribPointer(3, 1, gl.FLOAT, false, S, 32);
		const ib = gl.createBuffer()!;
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, usage);
		gl.bindVertexArray(null);
		return { vao, buffers: [vb, ib] };
	};
	const centreOf = (m: AdvancedMember, mesh: Mesh) => {
		const pts = worldPoints({ member: m, mesh });
		return pts.reduce(
			(a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length] as Vec3,
			[0, 0, 0] as Vec3,
		);
	};
	const matRows = Math.max(1, input.members.length * MAX_SLOTS);
	const matData = new Float32Array(matRows * MAT_TEXELS * 4);
	const ramps: NonNullable<SurfaceState['ramp']>[] = [];
	let transmissive = false;
	input.members.forEach((m, i) => {
		const t = tex2d(gl, ps, `pic${i}`, 1, 1, 'rgba8');
		uploadPicture(gl, t, m.picture);
		// The picture texture is re-specified per frame: forget its cached size key.
		(t as { __key?: string }).__key = undefined;
		const matBase = i * MAX_SLOTS;
		m.surfaces?.slice(0, MAX_SLOTS).forEach((s, slot) => {
			if (!s) return;
			let row = -1;
			if (s.ramp && s.ramp.stops.length >= 2) {
				row = ramps.indexOf(s.ramp);
				if (row < 0) row = ramps.push(s.ramp) - 1;
			}
			writeSurface(matData, (matBase + slot) * MAT_TEXELS * 4, s, row);
			matData[(matBase + slot) * MAT_TEXELS * 4 + 27] = 1; // physical
			if (s.transmission > 0.001 && m.draw) transmissive = true;
		});
		for (let slot = 0; slot < MAX_SLOTS; slot++)
			if (!m.surfaces?.[slot]) matData[(matBase + slot) * MAT_TEXELS * 4 + 18] = -1;
		if (m.model) {
			m.model.model.primitives.forEach((p, k) => {
				const mesh = primitiveMesh(ps, p);
				if (mesh.indices.length === 0) return;
				const img = m.model!.textures[k];
				let ptex: WebGLTexture | null = null;
				if (img) {
					ptex = ps.modelTex.get(img) ?? null;
					if (!ptex) {
						if (ps.modelTex.size >= MAX_MODEL_TEXTURES) {
							const [first] = ps.modelTex;
							gl.deleteTexture(first![1]);
							ps.modelTex.delete(first![0]);
						}
						ptex = gl.createTexture()!;
						ps.modelTex.set(img, ptex);
						gl.bindTexture(gl.TEXTURE_2D, ptex);
						gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
						gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
						// glTF base colour textures are sRGB: an sRGB format reads them as linear light, mips included.
						gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
						gl.generateMipmap(gl.TEXTURE_2D);
						gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
						gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
						gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
						gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
					}
				}
				const g = cached(mesh);
				prepared.push({
					member: m,
					mesh,
					centre: centreOf(m, mesh),
					vao: g.vao,
					buffers: [],
					count: mesh.indices.length,
					tex: t,
					bounds: g.bounds,
					matBase,
					prim: { material: p.material, tex: ptex },
				});
			});
			return;
		}
		const mesh = m.mesh ?? pictureQuad(m);
		if (!mesh || mesh.indices.length === 0) return;
		if (m.mesh) {
			const g = cached(mesh);
			prepared.push({
				member: m,
				mesh,
				centre: centreOf(m, mesh),
				vao: g.vao,
				buffers: [],
				count: mesh.indices.length,
				tex: t,
				bounds: g.bounds,
				matBase,
			});
			return;
		}
		const { vao, buffers } = upload(mesh);
		prepared.push({
			member: m,
			mesh,
			centre: centreOf(m, mesh),
			vao,
			buffers,
			count: mesh.indices.length,
			tex: t,
			bounds: meshBounds(mesh),
			matBase,
		});
	});
	gl.bindVertexArray(null);
	gl.bindBuffer(gl.ARRAY_BUFFER, null);
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
	// Solids that stopped being drawn leave the GPU.
	if (ps.meshes.size > MAX_GPU_MESHES)
		for (const [mesh, g] of ps.meshes)
			if (ps.frame - g.used > GPU_MESH_FRAMES || ps.meshes.size > MAX_GPU_MESHES * 2) {
				if (g.used === ps.frame) continue;
				gl.deleteVertexArray(g.vao);
				for (const b of g.buffers) gl.deleteBuffer(b);
				ps.meshes.delete(mesh);
			}
	const allPts = prepared.flatMap((p) => worldPoints(p));

	const bindMember = (prog: WebGLProgram, p: Prepared, unit: number) => {
		const m = p.member;
		gl.uniformMatrix4fv(U(gl, ps, prog, 'u_world'), false, colMajor(m.world));
		gl.uniformMatrix3fv(U(gl, ps, prog, 'u_normalMat'), false, colMajor3(normalMatrix(m.world)));
		gl.uniformMatrix3fv(U(gl, ps, prog, 'u_l2p'), false, colMajor3(m.layerToPicture as number[]));
		gl.uniform2f(U(gl, ps, prog, 'u_picSize'), m.pictureWidth, m.pictureHeight);
		gl.uniform1f(U(gl, ps, prog, 'u_opacity'), m.opacity);
		gl.uniform1i(U(gl, ps, prog, 'u_solid'), m.mesh ? 1 : 0);
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, p.tex);
		gl.uniform1i(U(gl, ps, prog, 'u_pic'), unit);
		const mat = p.prim?.material;
		gl.uniform1i(U(gl, ps, prog, 'u_model'), mat ? 1 : 0);
		if (mat) {
			gl.uniform4f(
				U(gl, ps, prog, 'u_baseColor'),
				mat.baseColor[0],
				mat.baseColor[1],
				mat.baseColor[2],
				mat.baseColor[3],
			);
			gl.uniform1i(U(gl, ps, prog, 'u_hasBaseTex'), p.prim!.tex ? 1 : 0);
			gl.uniform1i(
				U(gl, ps, prog, 'u_alphaMode'),
				mat.alphaMode === 'BLEND' ? 2 : mat.alphaMode === 'MASK' ? 1 : 0,
			);
			gl.uniform1f(U(gl, ps, prog, 'u_alphaCutoff'), mat.alphaCutoff);
			gl.uniform2f(
				U(gl, ps, prog, 'u_mr'),
				Math.min(1, Math.max(0, mat.metallic)),
				Math.min(1, Math.max(0, mat.roughness)),
			);
			gl.uniform3f(U(gl, ps, prog, 'u_emissive'), mat.emissive[0], mat.emissive[1], mat.emissive[2]);
		}
		gl.activeTexture(gl.TEXTURE0 + unit + 5);
		gl.bindTexture(gl.TEXTURE_2D, p.prim?.tex ?? p.tex);
		gl.uniform1i(U(gl, ps, prog, 'u_baseTex'), unit + 5);
	};
	const draw = (p: Prepared) => {
		gl.bindVertexArray(p.vao);
		gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
	};
	const setSceneUniforms = (prog: WebGLProgram) => {
		gl.uniform1i(U(gl, ps, prog, 'u_hdr'), hdr ? 1 : 0);
		gl.uniform1f(U(gl, ps, prog, 'u_exposure'), look.exposure);
	};

	// 2. shadow maps
	const S = Math.max(256, Math.min(4096, Math.round(input.shadowMapSize || 1024)));
	type Tile = { vp: Matrix4; texel: number; persp: boolean };
	const tiles: Tile[] = [];
	const firstTile = new Map<number, number>();
	lights.forEach((l, i) => {
		if (!l.castsShadows || l.type === 'ambient') return;
		const ts = shadowTiles(l, allPts, S);
		if (tiles.length + ts.length > ADVANCED_MAX_SHADOW_TILES) return;
		firstTile.set(i, tiles.length);
		tiles.push(...ts);
	});
	const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
	const cols = Math.max(1, Math.min(tiles.length, Math.floor(maxTex / S)));
	const rows = Math.max(1, Math.ceil(tiles.length / cols));
	const atlasW = cols * S;
	const atlasH = rows * S;
	if (atlasH > maxTex)
		throw new Error(
			`THREE_D_TOO_LARGE: ${tiles.length} shadow maps of ${S}² do not fit a ${maxTex}² texture`,
		);
	const shadowAtlas = tex2d(gl, ps, 'shadowAtlas', atlasW, atlasH, 'depth24');
	if (tiles.length > 0) {
		gl.bindFramebuffer(gl.FRAMEBUFFER, ps.shadowFbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowAtlas, 0);
		gl.drawBuffers([gl.NONE]);
		gl.readBuffer(gl.NONE);
		gl.viewport(0, 0, atlasW, atlasH);
		gl.depthMask(true);
		gl.clearDepth(1);
		gl.clear(gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LESS);
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(1.5, 4);
		const prog = ps.shadow;
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		gl.useProgram(prog);
		const casters = prepared.filter((p) => p.member.material.castsShadows !== 0);
		tiles.forEach((t, k) => {
			gl.viewport((k % cols) * S, Math.floor(k / cols) * S, S, S);
			gl.uniformMatrix4fv(U(gl, ps, prog, 'u_viewProj'), false, colMajor(t.vp));
			for (const p of casters) {
				bindMember(prog, p, 0);
				draw(p);
			}
		});
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
	}
	const tileData = new Float32Array(Math.max(1, tiles.length) * 5 * 4);
	tiles.forEach((t, k) => {
		const c = colMajor(t.vp);
		tileData.set(c, k * 20);
		tileData.set([t.texel, t.persp ? 1 : 0, 0, 0], k * 20 + 16);
	});
	const tileTex = tex2d(gl, ps, 'tiles', 5, Math.max(1, tiles.length), 'rgba32f');
	gl.bindTexture(gl.TEXTURE_2D, tileTex);
	gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 5, Math.max(1, tiles.length), gl.RGBA, gl.FLOAT, tileData);
	const TYPE = { ambient: 0, parallel: 1, point: 2, spot: 3, environment: 0 } as const;
	const ld = new Float32Array(Math.max(1, lights.length) * LIGHT_TEXELS * 4);
	lights.forEach((l, i) => {
		const o = i * LIGHT_TEXELS * 4;
		ld.set([TYPE[l.type], l.falloff, l.castsShadows && firstTile.has(i) ? 1 : 0, firstTile.get(i) ?? -1], o);
		ld.set([l.pos[0], l.pos[1], l.pos[2], 0], o + 4);
		ld.set([l.dir[0], l.dir[1], l.dir[2], 0], o + 8);
		ld.set([l.color[0], l.color[1], l.color[2], 0], o + 12);
		ld.set([l.coneHalf, l.feather, l.radius, l.falloffDistance], o + 16);
		ld.set([l.shadowDarkness, l.shadowDiffusion, 0, 0], o + 20);
	});
	const lightTex = tex2d(gl, ps, 'lights', LIGHT_TEXELS, Math.max(1, lights.length), 'rgba32f');
	gl.bindTexture(gl.TEXTURE_2D, lightTex);
	gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHT_TEXELS, Math.max(1, lights.length), gl.RGBA, gl.FLOAT, ld);

	// 3. environment
	let envTex: WebGLTexture | null = null;
	let irrTex: WebGLTexture | null = null;
	let envLod = 0;
	if (env && hdr) {
		if (envSource) {
			const key = envKey ?? 'image';
			let maps = ps.envs.get(key);
			if (!maps) {
				maps = buildEnvMaps(kitOf(gl, ps), envSource);
				ps.envs.set(key, maps);
				if (ps.envs.size > MAX_ENVS) {
					const [first] = ps.envs;
					gl.deleteTexture(first![1].radiance);
					gl.deleteTexture(first![1].irradiance);
					ps.envs.delete(first![0]);
				}
			}
			envTex = maps.radiance;
			irrTex = maps.irradiance;
		}
	} else if (env?.image) {
		envTex = tex2d(gl, ps, 'env', 1, 1, 'rgba8');
		gl.bindTexture(gl.TEXTURE_2D, envTex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, env.image);
		gl.generateMipmap(gl.TEXTURE_2D);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		(envTex as { __key?: string }).__key = undefined;
		const iw = (env.image as { width: number }).width;
		const ih = (env.image as { height: number }).height;
		envLod = Math.floor(Math.log2(Math.max(1, iw, ih)));
	}

	// 4. the main pass: multisampled colour + depth
	let near = 1;
	let far = 10;
	{
		let zmin = Number.POSITIVE_INFINITY;
		let zmax = Number.NEGATIVE_INFINITY;
		for (const p of allPts) {
			const z = mat4Apply(cam.view, p)[2];
			zmin = Math.min(zmin, z);
			zmax = Math.max(zmax, z);
		}
		if (Number.isFinite(zmin)) {
			if (cam.ortho) {
				near = zmin - 10;
				far = zmax + 10;
			} else {
				near = Math.max(1, zmin * 0.9);
				far = Math.max(near * 2, zmax * 1.1);
			}
		}
	}
	const viewProj = cameraClip(cam, setup.frame, near, far);
	const colorFormat = hdr ? gl.RGBA16F : gl.RGBA8;
	// A float format may multisample less than the context's maximum.
	const formatSamples = gl.getInternalformatParameter(
		gl.RENDERBUFFER,
		colorFormat,
		gl.SAMPLES,
	) as Int32Array | null;
	const samples = Math.max(
		1,
		Math.min(k > 1 ? 2 : 4, gl.getParameter(gl.MAX_SAMPLES) as number, formatSamples?.[0] ?? 4),
	);
	const colorRb = renderbuffer(gl, ps, 'color', RW, RH, colorFormat, samples);
	const depthRb = renderbuffer(gl, ps, 'depth', RW, RH, gl.DEPTH_COMPONENT24, samples);
	const transRb = transmissive ? renderbuffer(gl, ps, 'colorTrans', RW, RH, gl.RGBA16F, samples) : null;
	gl.bindFramebuffer(gl.FRAMEBUFFER, ps.fbo);
	gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRb);
	gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, transRb);
	gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
	if (transRb) {
		gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
		gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
	}
	gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
	gl.readBuffer(gl.COLOR_ATTACHMENT0);
	gl.viewport(0, 0, RW, RH);
	gl.clearColor(0, 0, 0, 0);
	gl.clearDepth(1);
	gl.depthMask(true);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	// Background: the composite below the run, then the environment when it is the background. In linear light the
	// backdrop stays out of the scene: it is composited under the tone mapped result, so the tone curve never touches it.
	gl.disable(gl.DEPTH_TEST);
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(ps.back);
	gl.bindVertexArray(ps.quadVao);
	gl.uniform1i(U(gl, ps, ps.back, 'u_hdr'), hdr ? 1 : 0);
	gl.uniform1f(U(gl, ps, ps.back, 'u_exposure'), look.exposure);
	let back: WebGLTexture | null = null;
	if (input.backdrop) {
		back = tex2d(gl, ps, 'backdrop', 1, 1, 'rgba8');
		uploadPicture(gl, back, input.backdrop);
		(back as { __key?: string }).__key = undefined;
	}
	if (back && !hdr) {
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, back);
		gl.uniform1i(U(gl, ps, ps.back, 'u_back'), 0);
		gl.uniform1i(U(gl, ps, ps.back, 'u_mode'), 0);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}
	if (env?.background && envTex) {
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, envTex);
		gl.uniform1i(U(gl, ps, ps.back, 'u_env'), 1);
		gl.uniform1i(U(gl, ps, ps.back, 'u_mode'), 1);
		gl.uniformMatrix4fv(
			U(gl, ps, ps.back, 'u_invViewProj'),
			false,
			colMajor(mat4Invert(viewProj) ?? viewProj),
		);
		gl.uniform3f(U(gl, ps, ps.back, 'u_eye'), cam.eye[0], cam.eye[1], cam.eye[2]);
		gl.uniform3f(U(gl, ps, ps.back, 'u_fwd'), cam.view[8]!, cam.view[9]!, cam.view[10]!);
		gl.uniform1i(U(gl, ps, ps.back, 'u_ortho'), cam.ortho ? 1 : 0);
		gl.uniform4f(U(gl, ps, ps.back, 'u_envColor'), env.color[0], env.color[1], env.color[2], env.rotation);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}
	const prog = ps.main;
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(prog);
	gl.uniformMatrix4fv(U(gl, ps, prog, 'u_viewProj'), false, colMajor(viewProj));
	gl.uniform3f(U(gl, ps, prog, 'u_eye'), cam.eye[0], cam.eye[1], cam.eye[2]);
	gl.uniform3f(U(gl, ps, prog, 'u_fwd'), cam.view[8]!, cam.view[9]!, cam.view[10]!);
	gl.uniform1i(U(gl, ps, prog, 'u_ortho'), cam.ortho ? 1 : 0);
	gl.uniform1i(U(gl, ps, prog, 'u_lightCount'), lights.length);
	gl.uniform1i(U(gl, ps, prog, 'u_lights'), 1);
	gl.uniform1i(U(gl, ps, prog, 'u_shadowAtlas'), 2);
	gl.uniform1i(U(gl, ps, prog, 'u_tiles'), 3);
	gl.uniform3f(U(gl, ps, prog, 'u_atlas'), S, cols, atlasW);
	gl.uniform1i(U(gl, ps, prog, 'u_env'), 4);
	gl.uniform1i(U(gl, ps, prog, 'u_hasEnv'), envTex ? 1 : 0);
	gl.uniform4f(
		U(gl, ps, prog, 'u_envColor'),
		env?.color[0] ?? 0,
		env?.color[1] ?? 0,
		env?.color[2] ?? 0,
		env?.rotation ?? 0,
	);
	gl.uniform1f(U(gl, ps, prog, 'u_envLod'), envLod);
	gl.uniform1i(U(gl, ps, prog, 'u_irr'), 11);
	const matTex = tex2d(gl, ps, 'materials', MAT_TEXELS, matRows, 'rgba32f');
	gl.bindTexture(gl.TEXTURE_2D, matTex);
	gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAT_TEXELS, matRows, gl.RGBA, gl.FLOAT, matData);
	gl.uniform1i(U(gl, ps, prog, 'u_mats'), 12);
	const rampTex = tex2d(gl, ps, 'ramps', RAMP_SIZE, Math.max(1, ramps.length), 'rgba8');
	gl.bindTexture(gl.TEXTURE_2D, rampTex);
	if (ramps.length) {
		const data = new Uint8Array(RAMP_SIZE * 4 * ramps.length);
		ramps.forEach((r, i) => {
			bakeRamp(r, data, i * RAMP_SIZE * 4);
		});
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, RAMP_SIZE, ramps.length, gl.RGBA, gl.UNSIGNED_BYTE, data);
	}
	gl.uniform1i(U(gl, ps, prog, 'u_ramps'), 13);
	gl.uniform1f(U(gl, ps, prog, 'u_rampRows'), Math.max(1, ramps.length));
	gl.uniform2f(U(gl, ps, prog, 'u_targetSize'), RW, RH);
	gl.uniform1f(U(gl, ps, prog, 'u_zoomPx'), (cam.zoom * RW) / Math.max(1, setup.frame.width));
	setSceneUniforms(prog);
	/** The scene's textures on their units: the passes between the main passes use the low units. */
	const bindScene = () => {
		for (const [unit, t] of [
			[1, lightTex],
			[2, shadowAtlas],
			[3, tileTex],
			[4, envTex ?? lightTex],
			[11, irrTex ?? lightTex],
			[12, matTex],
			[13, rampTex],
		] as const) {
			gl.activeTexture(gl.TEXTURE0 + unit);
			gl.bindTexture(gl.TEXTURE_2D, t);
		}
	};
	bindScene();
	const sceneLit = lights.length > 0 || !!envTex;
	const setMaterial = (p: Prepared) => {
		const m = p.member.material;
		gl.uniform1i(U(gl, ps, prog, 'u_lit'), sceneLit && m.acceptsLights ? 1 : 0);
		gl.uniform4f(U(gl, ps, prog, 'u_m0'), m.ambient, m.diffuse, m.specular, m.shininess);
		gl.uniform4f(U(gl, ps, prog, 'u_m1'), m.metal, m.reflection, m.reflectionSharpness, m.acceptsShadows);
		gl.uniform1i(U(gl, ps, prog, 'u_matBase'), p.matBase);
		gl.uniform4f(U(gl, ps, prog, 'u_bounds'), p.bounds[0], p.bounds[1], p.bounds[2], p.bounds[3]);
		const w = p.member.world;
		const axis = (x: number, y: number, z: number) => {
			const l = Math.hypot(x, y, z) || 1;
			return [x / l, y / l, z / l] as const;
		};
		const ax = axis(w[0]!, w[4]!, w[8]!);
		const ay = axis(w[1]!, w[5]!, w[9]!);
		gl.uniform3f(U(gl, ps, prog, 'u_axisX'), ax[0], ax[1], ax[2]);
		gl.uniform3f(U(gl, ps, prog, 'u_axisY'), ay[0], ay[1], ay[2]);
	};
	const drawn = prepared.filter((p) => p.member.draw);
	gl.enable(gl.DEPTH_TEST);
	gl.depthFunc(gl.LEQUAL);
	// Opaque pixels, in stack order (coplanar layers: the upper one wins).
	gl.depthMask(true);
	gl.uniform1i(U(gl, ps, prog, 'u_pass'), 0);
	for (const p of drawn) {
		bindMember(prog, p, 0);
		setMaterial(p);
		draw(p);
	}
	// Transparent pixels far → near, blended, no depth writes.
	const depthOf = (p: Prepared) => mat4Apply(cam.view, p.centre)[2];
	const sorted = [...drawn].sort((a, b) => depthOf(b) - depthOf(a));
	gl.depthMask(false);
	gl.enable(gl.BLEND);
	gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	gl.uniform1i(U(gl, ps, prog, 'u_pass'), 1);
	for (const p of sorted) {
		bindMember(prog, p, 0);
		setMaterial(p);
		draw(p);
	}
	gl.disable(gl.BLEND);
	gl.depthMask(true);
	gl.bindVertexArray(null);

	// 5. resolve
	const kit = hdr ? kitOf(gl, ps) : null;
	const resolveTo = (attachment: number, dst: WebGLTexture) => {
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, ps.fbo);
		gl.readBuffer(attachment);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, ps.fbo2);
		gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
		gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
		gl.blitFramebuffer(0, 0, RW, RH, 0, 0, RW, RH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
	};
	/** The expanded (premultiplied linear) scene so far, at the output size. */
	const sceneLinear = (name: string) => {
		const raw = kit!.target(`${name}:raw`, RW, RH);
		resolveTo(gl.COLOR_ATTACHMENT0, raw);
		const full = kit!.target(`${name}:full`, RW, RH);
		expandResolved(kit!, raw, full, RW, RH, look.exposure);
		if (k === 1) return full;
		const out = kit!.target(name, W, H);
		downsample(kit!, full, RH, out, W, H, k, name);
		return out;
	};
	if (kit && transmissive) {
		// What the glass sees: the opaque scene, tone mapped, over the backdrop, in linear light; blurred levels for rough glass.
		const scene = sceneLinear('glassScene');
		const mips = Math.floor(Math.log2(Math.max(RW, RH))) + 1;
		const transBack = kit.target('transBack', RW, RH, mips);
		composite(
			kit,
			{
				scene,
				trans: null,
				glint: null,
				backdrop: back,
				mode: TONE_MODE[look.toneMapping],
				exposure: look.exposure,
			},
			RW,
			RH,
			transBack,
		);
		gl.bindTexture(gl.TEXTURE_2D, transBack);
		gl.generateMipmap(gl.TEXTURE_2D);
		gl.bindFramebuffer(gl.FRAMEBUFFER, ps.fbo);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
		gl.viewport(0, 0, RW, RH);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.depthMask(true);
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		gl.useProgram(prog);
		bindScene();
		gl.activeTexture(gl.TEXTURE14);
		gl.bindTexture(gl.TEXTURE_2D, transBack);
		gl.uniform1i(U(gl, ps, prog, 'u_transBack'), 14);
		gl.uniform1i(U(gl, ps, prog, 'u_pass'), 2);
		for (const p of drawn) {
			bindMember(prog, p, 0);
			setMaterial(p);
			draw(p);
		}
		gl.bindVertexArray(null);
		gl.disable(gl.DEPTH_TEST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, ps.fbo);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
	}
	const resolved = hdr ? sceneLinear('scene') : tex2d(gl, ps, 'resolved', W, H, 'rgba8');
	if (!hdr) resolveTo(gl.COLOR_ATTACHMENT0, resolved);
	let transResolved: WebGLTexture | null = null;
	if (kit && transRb) {
		const raw = kit.target('sceneTrans:raw', RW, RH);
		resolveTo(gl.COLOR_ATTACHMENT1, raw);
		if (k === 1) transResolved = raw;
		else {
			transResolved = kit.target('sceneTrans', W, H);
			downsample(kit, raw, RH, transResolved, W, H, k, 'sceneTrans');
		}
	}

	// 6. depth of field (screen space) or a plain copy, into the shared canvas
	const dof = draft ? null : cam.dof;
	let depthTex: WebGLTexture | null = null;
	if (dof && drawn.length) {
		if (!h.floatTargets)
			throw new Error(
				'WEBGL_UNAVAILABLE: depth of field needs float render targets (EXT_color_buffer_float)',
			);
		depthTex = tex2d(gl, ps, 'viewDepth', W, H, 'r32f');
		const depthRb1 = renderbuffer(gl, ps, 'depth1', W, H, gl.DEPTH_COMPONENT24, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, ps.fbo2);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, depthTex, 0);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb1);
		gl.viewport(0, 0, W, H);
		gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
		gl.clear(gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LESS);
		const dp = ps.depth;
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		gl.useProgram(dp);
		gl.uniformMatrix4fv(U(gl, ps, dp, 'u_viewProj'), false, colMajor(viewProj));
		gl.uniform3f(U(gl, ps, dp, 'u_eye'), cam.eye[0], cam.eye[1], cam.eye[2]);
		gl.uniform3f(U(gl, ps, dp, 'u_fwd'), cam.view[8]!, cam.view[9]!, cam.view[10]!);
		for (const p of drawn) {
			bindMember(dp, p, 0);
			draw(p);
		}
		gl.bindVertexArray(null);
		gl.disable(gl.DEPTH_TEST);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
	}
	ensureCanvas(h, W, H);
	// Linear light: the depth of field goes into a float target, the composite to the canvas after it.
	const dofOut = kit ? kit.target('sceneDof', W, H) : null;
	gl.bindFramebuffer(gl.FRAMEBUFFER, dofOut ? ps.fbo2 : null);
	if (dofOut) {
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dofOut, 0);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
	}
	gl.viewport(0, 0, W, H);
	gl.disable(gl.DEPTH_TEST);
	const fp = ps.dof;
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(fp);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, resolved);
	gl.uniform1i(U(gl, ps, fp, 'u_color'), 0);
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, depthTex ?? resolved);
	gl.uniform1i(U(gl, ps, fp, 'u_depth'), 1);
	gl.uniform2f(U(gl, ps, fp, 'u_size'), W, H);
	const scale = W / Math.max(1, setup.frame.width);
	if (dof && depthTex) {
		const taps = irisTaps(dof.iris.sides, (dof.iris.rotation * Math.PI) / 180, 96);
		gl.uniform2fv(U(gl, ps, fp, 'u_taps'), new Float32Array(taps));
		gl.uniform1i(U(gl, ps, fp, 'u_tapCount'), taps.length / 2);
		gl.uniform4f(U(gl, ps, fp, 'u_dof'), dof.aperture, dof.focus, dof.blurLevel, scale);
		// Largest blur radius in the scene (output px).
		let maxR = 0;
		for (const p of allPts) maxR = Math.max(maxR, circleOfConfusion(dof, mat4Apply(cam.view, p)[2]) * scale);
		gl.uniform1f(U(gl, ps, fp, 'u_maxR'), Math.min(MAX_DOF_RADIUS * scale, maxR));
	} else {
		gl.uniform1i(U(gl, ps, fp, 'u_tapCount'), 0);
		gl.uniform1f(U(gl, ps, fp, 'u_maxR'), 0);
		gl.uniform4f(U(gl, ps, fp, 'u_dof'), 0, 0, 0, scale);
	}
	// The resolved texture holds GL rows as rendered (NDC y up = the top of the frame); `blit` reads the canvas's
	// bottom-left W × H region, so a plain copy keeps the picture upright.
	gl.bindVertexArray(ps.quadVao);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	// What glass transmits goes out of focus with the solid it passes through.
	if (kit && transResolved && dof && depthTex) {
		const transDof = kit.target('transDof', W, H);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, transDof, 0);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, transResolved);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		transResolved = transDof;
	}
	gl.bindVertexArray(null);
	gl.activeTexture(gl.TEXTURE0);
	if (kit && dofOut) {
		const scale2 = W / Math.max(1, setup.frame.width);
		const g = look.glint;
		const glint = g
			? renderGlint(kit, dofOut, W, H, {
					threshold: g.threshold,
					intensity: g.intensity,
					radiusPx: g.radius * scale2,
					rays: g.rays,
					lengthPx: g.length * scale2,
					detailPx: GLINT_DETAIL * scale2,
					pxScale: scale2,
					angle: g.angle,
					tint: [linearOf(g.tint[0]), linearOf(g.tint[1]), linearOf(g.tint[2])],
					exposure: look.exposure,
				})
			: null;
		ensureCanvas(h, W, H);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		composite(
			kit,
			{
				scene: dofOut,
				trans: transResolved,
				glint,
				backdrop: back,
				mode: TONE_MODE[look.toneMapping],
				exposure: look.exposure,
			},
			W,
			H,
			null,
		);
	}
	for (const p of prepared) {
		if (!p.buffers.length) continue;
		gl.deleteVertexArray(p.vao);
		for (const b of p.buffers) gl.deleteBuffer(b);
	}
	if (gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the GPU context was lost while drawing');
	blit(h, out, W, H);
}

// Premiere ▸ Video Transitions ▸ Immersive Video: the VR transitions for 360° equirectangular footage (VR Chroma
// Leaks, VR Gradient Wipe, VR Iris Wipe, VR Light Leaks, VR Light Rays, VR Mobius Zoom, VR Random Blocks, VR
// Spherical Blur). They work on the sphere, not on the flat frame: shapes, blocks and lights are laid out by
// direction, wrap seamlessly at the 0°/360° seam and squeeze correctly towards the poles. Like Premiere they have a
// Frame Layout (monoscopic, stereoscopic over/under or side by side: each eye is processed on its own). Part of the
// premiere-transitions family; the folder sits in MODERN_BINS.immersive until the framework has an Immersive Video bin.
import type { TransitionSpec } from '../../../transitions.ts';
import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { fxParam } from '../../fx/params.ts';
import type { GlslChunk } from '../../fx/shader.ts';
import { defineShaderTransition } from '../define.ts';
import { GLSL_TR_EASE, GLSL_TRANSITION } from '../glsl.ts';
import { GLSL_PR_MODERN, MODERN_BINS } from './modern-common.ts';

const bin = MODERN_BINS.immersive;
const kw = (...k: string[]) => [...k, 'vr', '360', 'immersive', 'immersive video', 'equirectangular'];

const LAYOUTS = ['mono', 'overUnder', 'sideBySide'] as const;
const LAYOUT_LABELS = ['Monoscopic', 'Stereoscopic - Over/Under', 'Stereoscopic - Side by Side'] as const;
const layoutParam = () => fxParam.choice('layout', 'Frame Layout', LAYOUTS, LAYOUT_LABELS, 'mono');
const targetParams = () => [fxParam.angle('pan', 'Target Pan', 0), fxParam.angle('tilt', 'Target Tilt', 0)];

/** `premiere/vr`: equirectangular ↔ sphere, frame layouts, target directions. */
const GLSL_PR_VR: GlslChunk = {
	name: 'premiere/vr',
	deps: [GLSL_TRANSITION],
	source: /* glsl */ `
const float VR_PI = 3.14159265358979;
// The eye sub-frame of v_uv (layout 0 mono, 1 over/under, 2 side by side): xy = uv inside the eye, z = eye index.
vec3 vr_eye(vec2 uv) {
  if (u_layout == 1) return vec3(uv.x, fract(clamp(uv.y, 0.0, 0.99999) * 2.0), floor(clamp(uv.y, 0.0, 0.99999) * 2.0));
  if (u_layout == 2) return vec3(fract(clamp(uv.x, 0.0, 0.99999) * 2.0), uv.y, floor(clamp(uv.x, 0.0, 0.99999) * 2.0));
  return vec3(uv, 0.0);
}
// Frame uv of a point of eye e (equirect uv inside the eye; longitude wraps, latitude clamps).
vec2 vr_frame(vec2 e, float eye) {
  e = vec2(fract(e.x), clamp(e.y, 0.0, 1.0));
  if (u_layout == 1) return vec2(e.x, (e.y + eye) * 0.5);
  if (u_layout == 2) return vec2((e.x + eye) * 0.5, e.y);
  return e;
}
// Equirect uv → unit direction (x right, y up, z forward at the frame centre) and back.
vec3 vr_dir(vec2 e) {
  float lon = (e.x - 0.5) * 2.0 * VR_PI;
  float lat = (0.5 - e.y) * VR_PI;
  return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
}
vec2 vr_uv(vec3 d) {
  d = normalize(d);
  return vec2(atan(d.x, d.z) / (2.0 * VR_PI) + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / VR_PI);
}
// The direction of a pan / tilt (degrees).
vec3 vr_target(float pan, float tilt) { return vr_dir(vec2(pan / 360.0 + 0.5, 0.5 - tilt / 180.0)); }
// Angle (radians) between two directions.
float vr_angle(vec3 a, vec3 b) { return acos(clamp(dot(a, b), -1.0, 1.0)); }
// An orthonormal frame around the target t (for azimuths and rotations about it).
mat3 vr_basis(vec3 t) {
  vec3 up = abs(t.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 x = normalize(cross(up, t));
  vec3 y = cross(t, x);
  return mat3(x, y, t);
}
vec4 vr_side(int side, vec2 frameUv) { return side == 0 ? texture(u_from, frameUv) : texture(u_to, frameUv); }
`,
};

/** Immersive Video ▸ VR Iris Wipe: B opens as a round iris on the sphere around a target direction. */
export const VR_IRIS_WIPE = defineShaderTransition({
	id: 'jasper.vr-iris-wipe',
	label: 'VR Iris Wipe',
	bin,
	description:
		'For 360° video: the incoming clip opens as a round iris on the sphere around a target direction, with a feathered edge.',
	keywords: kw('iris', 'round', 'wipe'),
	params: [...targetParams(), fxParam.angle('feather', 'Feather', 4), layoutParam()],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_VR],
				frag: /* glsl */ `
void main() {
  vec3 e = vr_eye(v_uv);
  float a = vr_angle(vr_dir(e.xy), vr_target(u_pan, u_tilt));
  float f = max(radians(u_feather), 1e-3);
  float r = mix(-f, VR_PI + f, tr_progress());
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(f * 0.5, -f * 0.5, a - r));
}`,
			},
		],
	},
});

const VR_GRADIENTS = ['topToBottom', 'aroundTheView', 'fromTarget', 'outgoingLuma', 'incomingLuma'] as const;
const VR_GRADIENT_LABELS = [
	'Top to Bottom',
	'Around the View',
	'Away from the Target',
	'Outgoing Clip Luminance',
	'Incoming Clip Luminance',
] as const;

/**
 * Immersive Video ▸ VR Gradient Wipe: B appears following a gradient laid on the sphere (dark first). Custom Gradient
 * takes a project image as an equirectangular gradient (stretched over each eye's frame); with no image the built-in
 * gradient choice applies.
 */
export const VR_GRADIENT_WIPE = defineShaderTransition({
	id: 'jasper.vr-gradient-wipe',
	label: 'VR Gradient Wipe',
	bin,
	description:
		'For 360° video: the incoming clip wipes in following a gradient laid out on the sphere (dark areas first), with softness.',
	keywords: kw('gradient', 'luma', 'wipe', 'soft'),
	params: [
		fxParam.choice('gradient', 'Gradient', VR_GRADIENTS, VR_GRADIENT_LABELS, 'topToBottom'),
		fxParam.media('gradientImage', 'Custom Gradient', ['image']),
		fxParam.percent('softness', 'Softness', 10),
		fxParam.toggle('invert', 'Invert Gradient', false),
		...targetParams(),
		layoutParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_VR, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec3 e = vr_eye(v_uv);
  vec3 d = vr_dir(e.xy);
  float g;
  if (u_gradientImage_size.x > 0.0) {
    // Custom Gradient: an equirectangular image laid on the sphere (each eye of a stereo layout gets all of it).
    vec4 gi = fx_unpremultiply(texture(u_gradientImage, e.xy));
    g = clamp(fx_luma(gi.rgb) * gi.a, 0.0, 1.0);
  }
  else if (u_gradient == 0) g = e.y;
  else if (u_gradient == 1) g = fract(e.x - u_pan / 360.0);
  else if (u_gradient == 2) g = vr_angle(d, vr_target(u_pan, u_tilt)) / VR_PI;
  else {
    vec4 c = fx_unpremultiply(u_gradient == 3 ? tr_from(v_uv) : tr_to(v_uv));
    g = clamp(fx_luma(c.rgb) * c.a, 0.0, 1.0);
  }
  if (u_invert) g = 1.0 - g;
  float s = max(u_softness / 100.0, 0.002);
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), clamp((tr_progress() * (1.0 + s) - g) / s, 0.0, 1.0));
}`,
			},
		],
	},
});

/** Immersive Video ▸ VR Random Blocks: B appears in blocks of the sphere's longitude / latitude grid. */
export const VR_RANDOM_BLOCKS = defineShaderTransition({
	id: 'jasper.vr-random-blocks',
	label: 'VR Random Blocks',
	bin,
	description:
		'For 360° video: the incoming clip appears in random blocks of the sphere (seamless across the 360° seam), with feathered edges.',
	keywords: kw('random', 'blocks', 'grid'),
	params: [
		fxParam.number('wide', 'Blocks Wide', 16, { min: 1, max: 200, softMax: 64, step: 1 }),
		fxParam.number('high', 'Blocks High', 8, { min: 1, max: 100, softMax: 32, step: 1 }),
		fxParam.percent('feather', 'Feather', 10),
		layoutParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_VR, GLSL_HASH],
				frag: /* glsl */ `
void main() {
  vec3 e = vr_eye(v_uv);
  vec2 grid = vec2(max(1.0, floor(u_wide + 0.5)), max(1.0, floor(u_high + 0.5)));
  vec2 g = vec2(fract(e.x), clamp(e.y, 0.0, 0.99999)) * grid;
  vec2 cell = floor(g);
  // The same random time for a block in both eyes (stereo pairs stay in sync).
  float t = 0.05 + 0.8 * fx_hash2(ivec2(cell), u_seed);
  // Feathered block edges: the block's corners lag a little behind its centre.
  vec2 f = abs(fract(g) - 0.5) * 2.0;
  float edge = max(f.x, f.y);
  float w = clamp(u_feather / 100.0, 0.0, 1.0) * 0.098;
  float te = t + w * smoothstep(0.6, 1.0, edge);
  float p = tr_progress();
  float k = w > 0.0 ? smoothstep(te - 0.5 * w, te + 0.5 * w, p) : step(te, p);
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), k);
}`,
			},
		],
	},
});

/** Immersive Video ▸ VR Spherical Blur: the sphere blurs (and brightens) through the cut. */
export const VR_SPHERICAL_BLUR = defineShaderTransition({
	id: 'jasper.vr-spherical-blur',
	expensive: true,
	label: 'VR Spherical Blur',
	bin,
	description:
		'For 360° video: the picture blurs on the sphere (wider towards the poles, seamless at the seam) and brightens through the change of clip.',
	keywords: kw('blur', 'spherical', 'defocus', 'exposure'),
	params: [
		fxParam.angle('blur', 'Blur Intensity', 8),
		fxParam.percent('exposure', 'Exposure', 30),
		layoutParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_VR, GLSL_PR_MODERN],
				frag: /* glsl */ `
// A blur on the sphere: taps on rings around the direction, rotated in a golden-angle spiral.
vec4 vrBlur(int side, vec3 e, float radius) {
  vec3 d = vr_dir(e.xy);
  mat3 B = vr_basis(d);
  vec4 s = vr_side(side, vr_frame(e.xy, e.z));
  float wsum = 1.0;
  for (int i = 1; i <= 24; i++) {
    float r = radius * sqrt(float(i) / 24.0);
    float a = float(i) * 2.39996323;
    vec3 q = normalize(B * vec3(sin(r) * cos(a), sin(r) * sin(a), cos(r)));
    s += vr_side(side, vr_frame(vr_uv(q), e.z));
    wsum += 1.0;
  }
  return s / wsum;
}
void main() {
  float p = tr_progress();
  vec3 e = vr_eye(v_uv);
  float b = pm_bump(p);
  float radius = radians(u_blur) * b;
  float k = pm_switch(p, 0.15);
  vec4 A = k < 1.0 ? vrBlur(0, e, radius) : vec4(0.0);
  vec4 Bc = k > 0.0 ? vrBlur(1, e, radius) : vec4(0.0);
  if (!u_hasFrom) A = vec4(0.0);
  if (!u_hasTo) Bc = vec4(0.0);
  vec4 c = mix(A, Bc, k);
  c.rgb = min(c.rgb * (1.0 + (u_exposure / 100.0) * 2.0 * b), vec3(c.a));
  fragColor = c;
}`,
			},
		],
	},
});

/** Immersive Video ▸ VR Mobius Zoom: a Möbius zoom on the sphere into a target, through to B. */
export const VR_MOBIUS_ZOOM = defineShaderTransition({
	id: 'jasper.vr-mobius-zoom',
	label: 'VR Mobius Zoom',
	bin,
	description:
		'For 360° video: a Möbius zoom on the sphere — the view rushes into a target direction and the incoming clip unfolds out of it.',
	keywords: kw('mobius', 'zoom', 'warp', 'spherical'),
	params: [
		...targetParams(),
		fxParam.number('zoom', 'Zoom Level', 6, { min: 1, max: 50, softMax: 20, step: 0.1 }),
		layoutParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_VR, GLSL_TR_EASE],
				frag: /* glsl */ `
// Zoom the sphere by s around the target (stereographic projection from the opposite pole, scale, back).
vec2 vrZoom(vec3 d, mat3 B, float s) {
  vec3 l = transpose(B) * d;               // target = +z
  vec2 st = l.xy / max(1.0 + l.z, 1e-4);   // stereographic plane
  st /= s;
  float r2 = dot(st, st);
  vec3 m = vec3(2.0 * st, 1.0 - r2) / (1.0 + r2);
  return vr_uv(B * m);
}
void main() {
  float p = tr_progress();
  vec3 e = vr_eye(v_uv);
  vec3 d = vr_dir(e.xy);
  mat3 B = vr_basis(vr_target(u_pan, u_tilt));
  float z = max(u_zoom, 1.0);
  // A zooms in 1 → z, B arrives zoomed out 1/z → 1 (one continuous push).
  float sa = pow(z, tr_easeIn(clamp(2.0 * p, 0.0, 1.0)));
  float sb = pow(z, -tr_easeOut(clamp(2.0 - 2.0 * p, 0.0, 1.0)));
  float k = smoothstep(0.42, 0.58, p);
  vec4 A = k < 1.0 ? vr_side(0, vr_frame(vrZoom(d, B, sa), e.z)) : vec4(0.0);
  vec4 Bc = k > 0.0 ? vr_side(1, vr_frame(vrZoom(d, B, sb), e.z)) : vec4(0.0);
  if (p <= 0.0) A = tr_from(v_uv);
  if (p >= 1.0) Bc = tr_to(v_uv);
  fragColor = mix(A, Bc, k);
}`,
			},
		],
	},
});

/** A seamless 3D value-noise fbm on the sphere (directions in, 0..1 out). */
const SPHERE_NOISE = /* glsl */ `
float vrFbm(vec3 d, float seed) {
  float s = 0.0, a = 0.5;
  vec3 q = d * 1.6;
  for (int k = 0; k < 3; k++) {
    s += a * (0.5 + 0.5 * fx_valueNoise3(q, fract(seed + float(k) * 0.137)));
    q = q * 2.07 + vec3(3.1, 7.7, 1.3);
    a *= 0.5;
  }
  return s / 0.875;
}`;

/** Immersive Video ▸ VR Light Leaks: warm leaks of light drift over the sphere through the cut. */
export const VR_LIGHT_LEAKS = defineShaderTransition({
	id: 'jasper.vr-light-leaks',
	label: 'VR Light Leaks',
	bin,
	description:
		'For 360° video: warm, organic light leaks drift over the whole sphere and wash over the change of clip.',
	keywords: kw('light leak', 'leak', 'film burn', 'warm'),
	params: [
		fxParam.percent('intensity', 'Intensity', 100),
		fxParam.angle('hue', 'Color Shift', 0),
		layoutParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_VR, GLSL_PR_MODERN, GLSL_NOISE, GLSL_COLOR],
				frag: /* glsl */ `${SPHERE_NOISE}
void main() {
  float p = tr_progress();
  vec3 e = vr_eye(v_uv);
  vec3 d = vr_dir(e.xy);
  // The leak field turns slowly around the vertical axis during the transition.
  float r = p * 1.2;
  vec3 dr = vec3(cos(r) * d.x - sin(r) * d.z, d.y, sin(r) * d.x + cos(r) * d.z);
  float n = vrFbm(dr, u_seed);
  float m = smoothstep(0.45, 0.8, n);
  vec3 col = fx_hueShift(mix(vec3(0.95, 0.25, 0.05), vec3(1.0, 0.8, 0.35), smoothstep(0.55, 0.9, n)), u_hue / 360.0);
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(p, 0.2));
  fragColor = pm_addLight(base, col * m * (u_intensity / 100.0) * 1.6 * pm_bump(p));
}`,
			},
		],
	},
});

/** Immersive Video ▸ VR Chroma Leaks: saturated colour blobs drift around the sphere through the cut. */
export const VR_CHROMA_LEAKS = defineShaderTransition({
	id: 'jasper.vr-chroma-leaks',
	label: 'VR Chroma Leaks',
	bin,
	description:
		'For 360° video: saturated, multicolored light blobs drift around the sphere and wash over the change of clip.',
	keywords: kw('chroma', 'leak', 'color', 'light'),
	params: [
		fxParam.percent('intensity', 'Intensity', 100),
		fxParam.angle('hue', 'Color Shift', 0),
		layoutParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_VR, GLSL_PR_MODERN, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec3 e = vr_eye(v_uv);
  vec3 d = vr_dir(e.xy);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    vec4 h = vec4(fx_hash22(ivec2(i, 5), u_seed), fx_hash22(ivec2(i, 17), u_seed));
    // Each blob drifts along a great circle.
    float lon = 6.2831853 * h.x + (h.z - 0.5) * 2.0 * p;
    float lat = (h.y - 0.5) * 2.2;
    vec3 c = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
    float a = vr_angle(d, c);
    float r = 0.35 + 0.4 * h.w;
    vec3 col = fx_hsv2rgb(vec3(fract(u_hue / 360.0 + u_seed + 0.17 * float(i)), 0.85, 1.0));
    light += col * exp(-a * a / (r * r));
  }
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(p, 0.25));
  fragColor = pm_addLight(base, light * (u_intensity / 100.0) * pow(pm_bump(p), 1.5));
}`,
			},
		],
	},
});

/** Immersive Video ▸ VR Light Rays: rays of light burst from a target direction on the sphere. */
export const VR_LIGHT_RAYS = defineShaderTransition({
	id: 'jasper.vr-light-rays',
	label: 'VR Light Rays',
	bin,
	description:
		'For 360° video: rays of light burst out of a target direction, flood the sphere at the cut and fade on the incoming clip.',
	keywords: kw('rays', 'light rays', 'god rays', 'beams'),
	params: [
		...targetParams(),
		fxParam.color('color', 'Light Color', [1, 0.9, 0.7, 1]),
		fxParam.percent('intensity', 'Intensity', 100),
		fxParam.number('rays', 'Rays', 24, { min: 2, max: 200, softMax: 64, step: 1 }),
		layoutParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_VR, GLSL_PR_MODERN, GLSL_NOISE],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec3 e = vr_eye(v_uv);
  vec3 d = vr_dir(e.xy);
  vec3 t = vr_target(u_pan, u_tilt);
  mat3 B = vr_basis(t);
  vec3 l = transpose(B) * d;
  float az = atan(l.y, l.x);
  float a = vr_angle(d, t);
  float n = max(2.0, floor(u_rays + 0.5));
  // Rays: noise around the azimuth (wrapping), growing out from the target as the transition peaks.
  float ray = 0.5 + 0.5 * fx_valueNoise(vec2(cos(az), sin(az)) * n * 0.25 + vec2(u_seed * 50.0, p * 2.0), u_seed);
  ray = pow(ray, 3.0);
  float b = pm_bump(p);
  float reach = mix(0.2, 2.6, b);
  float fall = exp(-a / max(reach, 1e-3) * 2.0);
  vec3 light = u_color.rgb * (ray * fall * 1.6 + exp(-a * 8.0) * 1.5);
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(p, 0.15));
  fragColor = pm_addLight(base, light * (u_intensity / 100.0) * b);
}`,
			},
		],
	},
});

export const PREMIERE_VR: readonly TransitionSpec[] = [
	VR_CHROMA_LEAKS,
	VR_GRADIENT_WIPE,
	VR_IRIS_WIPE,
	VR_LIGHT_LEAKS,
	VR_LIGHT_RAYS,
	VR_MOBIUS_ZOOM,
	VR_RANDOM_BLOCKS,
	VR_SPHERICAL_BLUR,
];

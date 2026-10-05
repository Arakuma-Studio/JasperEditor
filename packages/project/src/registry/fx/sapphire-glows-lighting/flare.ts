// Family-private lens-flare model of the Sapphire Glows + Lighting family: a flare is a list of ELEMENTS placed
// along the flare axis (from the light through the flare centre and beyond, like the internal reflections of a real
// lens). Each built-in lens (`FLARE_LENSES`) is one element list; the shader of a lens bakes its list as a GLSL
// const array (lens = hold-only popup, so the program changes only when the lens does) and every keyframable
// control (light position, centre, brightness, scale, colour, rotation…) stays a uniform.
//
// Element kinds (all analytic, resolution-independent, sized in units of the frame diagonal × Scale):
//   glow      radial light: a tight core plus a wide soft halo;
//   ring      a thin ring (halo) of radius size, optional chromatic split (rainbow edge);
//   rainbow   a wide spectral ring (the red-outside rainbow halo of real lenses);
//   poly      an iris ghost: a regular polygon (sides, rotation) with a soft edge and a brighter rim;
//   disc      a soft filled circle ghost;
//   streak    an anamorphic line through the element (angle relative to the flare, thickness);
//   spikes    a star of N thin spikes (glint) of length size;
//   burst     a starburst: many fine rays of random length around the element (seeded by the lens).
import type { GlslChunk } from '../shader.ts';
import { GLSL_SGL_CORE } from './glow.ts';

export type FlareKind = 'glow' | 'ring' | 'rainbow' | 'poly' | 'disc' | 'streak' | 'spikes' | 'burst';
const KIND_INDEX: Record<FlareKind, number> = {
	glow: 0,
	ring: 1,
	rainbow: 2,
	poly: 3,
	disc: 4,
	streak: 5,
	spikes: 6,
	burst: 7,
};

/**
 * One flare element. `pos`: place along the axis (0 = the light, 1 = the flare centre, 2 = mirrored through it;
 * negative = behind the light). `size`: radius (fraction of the frame diagonal). `a`, `b`: kind parameters
 * (ring: width, chroma; poly: sides, rotation°; streak: thickness, angle°; spikes: count, thickness; burst: ray
 * count, ray contrast; glow: core ratio, —; disc: softness, —). `color`: linear RGB tint; `i`: intensity.
 */
export type FlareElement = {
	kind: FlareKind;
	pos: number;
	size: number;
	color: [number, number, number];
	i: number;
	a?: number;
	b?: number;
};

export type FlareLens = { value: string; label: string; elements: FlareElement[] };

const W: [number, number, number] = [1, 1, 1];
const warm: [number, number, number] = [1, 0.75, 0.45];
const blue: [number, number, number] = [0.45, 0.65, 1];
const green: [number, number, number] = [0.5, 1, 0.6];
const violet: [number, number, number] = [0.75, 0.5, 1];
const amber: [number, number, number] = [1, 0.6, 0.2];
const teal: [number, number, number] = [0.3, 0.9, 0.9];
const rose: [number, number, number] = [1, 0.45, 0.6];

/** A run of polygon ghosts along the axis (iris reflections). */
function ghosts(
	sides: number,
	rot: number,
	list: [pos: number, size: number, color: [number, number, number], i: number][],
): FlareElement[] {
	return list.map(([pos, size, color, i]) => ({ kind: 'poly', pos, size, color, i, a: sides, b: rot }));
}

/** The built-in lenses (Sapphire ships flare presets; these are original designs in the same spirit). */
export const FLARE_LENSES: readonly FlareLens[] = [
	{
		value: 'prime35',
		label: '35mm Prime',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.12, color: warm, i: 1, a: 0.12 },
			{ kind: 'spikes', pos: 0, size: 0.16, color: W, i: 0.5, a: 6, b: 0.0025 },
			{ kind: 'ring', pos: 0, size: 0.09, color: warm, i: 0.12, a: 0.012, b: 0.4 },
			...ghosts(6, 15, [
				[0.35, 0.025, warm, 0.18],
				[0.6, 0.045, green, 0.12],
				[0.85, 0.02, blue, 0.2],
				[1.25, 0.06, violet, 0.08],
				[1.55, 0.035, teal, 0.12],
				[1.9, 0.09, warm, 0.06],
			]),
			{ kind: 'disc', pos: 1.1, size: 0.012, color: W, i: 0.35, a: 0.4 },
			{ kind: 'rainbow', pos: 2.1, size: 0.22, color: W, i: 0.12, a: 0.025 },
		],
	},
	{
		value: 'zoom70200',
		label: 'Zoom 70-200',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.1, color: W, i: 1, a: 0.1 },
			{ kind: 'burst', pos: 0, size: 0.22, color: warm, i: 0.35, a: 96, b: 0.6 },
			...ghosts(8, 0, [
				[0.2, 0.012, amber, 0.3],
				[0.45, 0.03, green, 0.12],
				[0.7, 0.018, blue, 0.18],
				[0.95, 0.05, violet, 0.08],
				[1.2, 0.025, green, 0.15],
				[1.4, 0.07, amber, 0.07],
				[1.65, 0.015, rose, 0.25],
				[2.2, 0.11, blue, 0.05],
			]),
			{ kind: 'ring', pos: 1.3, size: 0.15, color: blue, i: 0.08, a: 0.02, b: 0.6 },
		],
	},
	{
		value: 'anamorphicBlue',
		label: 'Anamorphic Blue',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.09, color: [0.7, 0.85, 1], i: 1.1, a: 0.15 },
			{ kind: 'streak', pos: 0, size: 0.9, color: [0.35, 0.6, 1], i: 0.9, a: 0.004, b: 0 },
			{ kind: 'streak', pos: 0, size: 0.35, color: [0.7, 0.85, 1], i: 0.6, a: 0.0015, b: 0 },
			{ kind: 'disc', pos: 0.5, size: 0.04, color: blue, i: 0.12, a: 0.6 },
			{ kind: 'disc', pos: 1.4, size: 0.07, color: [0.3, 0.5, 1], i: 0.1, a: 0.7 },
			{ kind: 'ring', pos: 1.8, size: 0.12, color: blue, i: 0.07, a: 0.015, b: 0.3 },
			{ kind: 'streak', pos: 1.8, size: 0.25, color: [0.3, 0.55, 1], i: 0.15, a: 0.003, b: 0 },
		],
	},
	{
		value: 'anamorphicGold',
		label: 'Anamorphic Gold',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.1, color: [1, 0.85, 0.6], i: 1.1, a: 0.15 },
			{ kind: 'streak', pos: 0, size: 0.85, color: amber, i: 0.85, a: 0.005, b: 0 },
			{ kind: 'streak', pos: 0, size: 0.3, color: [1, 0.9, 0.7], i: 0.6, a: 0.0015, b: 0 },
			{ kind: 'disc', pos: 0.6, size: 0.05, color: amber, i: 0.1, a: 0.6 },
			{ kind: 'disc', pos: 1.5, size: 0.08, color: rose, i: 0.08, a: 0.7 },
			{ kind: 'rainbow', pos: 0, size: 0.32, color: W, i: 0.06, a: 0.03 },
		],
	},
	{
		value: 'sunburst',
		label: 'Sunburst',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.2, color: [1, 0.9, 0.7], i: 1.3, a: 0.1 },
			{ kind: 'burst', pos: 0, size: 0.45, color: [1, 0.85, 0.6], i: 0.5, a: 160, b: 0.8 },
			{ kind: 'spikes', pos: 0, size: 0.3, color: W, i: 0.35, a: 4, b: 0.003 },
			{ kind: 'rainbow', pos: 0, size: 0.28, color: W, i: 0.08, a: 0.04 },
			...ghosts(5, 36, [
				[0.5, 0.03, warm, 0.1],
				[1.2, 0.05, amber, 0.08],
				[1.7, 0.02, W, 0.15],
			]),
		],
	},
	{
		value: 'hexIris',
		label: 'Hexagon Iris',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.08, color: W, i: 0.9, a: 0.15 },
			...ghosts(6, 0, [
				[0.25, 0.02, green, 0.25],
				[0.45, 0.04, teal, 0.18],
				[0.65, 0.065, blue, 0.12],
				[0.85, 0.03, violet, 0.2],
				[1.15, 0.08, rose, 0.08],
				[1.35, 0.045, amber, 0.15],
				[1.6, 0.12, green, 0.06],
				[1.85, 0.03, teal, 0.2],
				[2.2, 0.16, blue, 0.04],
			]),
		],
	},
	{
		value: 'rainbowHalo',
		label: 'Rainbow Halo',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.1, color: W, i: 1, a: 0.12 },
			{ kind: 'rainbow', pos: 0, size: 0.18, color: W, i: 0.2, a: 0.03 },
			{ kind: 'rainbow', pos: 1.6, size: 0.3, color: W, i: 0.12, a: 0.05 },
			{ kind: 'ring', pos: 0.7, size: 0.06, color: W, i: 0.1, a: 0.008, b: 1 },
			{ kind: 'disc', pos: 1.2, size: 0.03, color: violet, i: 0.15, a: 0.5 },
		],
	},
	{
		value: 'sciFi',
		label: 'Sci-Fi',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.07, color: [0.6, 0.9, 1], i: 1.2, a: 0.2 },
			{ kind: 'streak', pos: 0, size: 1.2, color: [0.4, 0.8, 1], i: 0.7, a: 0.0025, b: 0 },
			{ kind: 'spikes', pos: 0, size: 0.12, color: W, i: 0.5, a: 8, b: 0.002 },
			{ kind: 'ring', pos: 0, size: 0.06, color: teal, i: 0.2, a: 0.004, b: 0.2 },
			{ kind: 'ring', pos: 1, size: 0.1, color: blue, i: 0.1, a: 0.006, b: 0.3 },
			{ kind: 'ring', pos: 1.5, size: 0.04, color: teal, i: 0.15, a: 0.004, b: 0.3 },
			{ kind: 'disc', pos: 0.4, size: 0.015, color: teal, i: 0.3, a: 0.3 },
			{ kind: 'disc', pos: 2, size: 0.05, color: blue, i: 0.1, a: 0.6 },
		],
	},
	{
		value: 'warmSun',
		label: 'Warm Sun',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.28, color: [1, 0.7, 0.35], i: 1.2, a: 0.06 },
			{ kind: 'burst', pos: 0, size: 0.3, color: [1, 0.8, 0.5], i: 0.25, a: 120, b: 0.5 },
			{ kind: 'disc', pos: 0.55, size: 0.06, color: amber, i: 0.1, a: 0.8 },
			{ kind: 'disc', pos: 1.3, size: 0.1, color: [1, 0.5, 0.2], i: 0.07, a: 0.8 },
			{ kind: 'ring', pos: 1.9, size: 0.2, color: amber, i: 0.05, a: 0.03, b: 0.5 },
		],
	},
	{
		value: 'spotlight',
		label: 'Spotlight',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.15, color: W, i: 1.4, a: 0.2 },
			{ kind: 'spikes', pos: 0, size: 0.35, color: W, i: 0.45, a: 4, b: 0.0035 },
			{ kind: 'spikes', pos: 0, size: 0.18, color: W, i: 0.25, a: 4, b: 0.002 },
		],
	},
];

const STRIDE = 10;

/** The element list of a lens as a flat float list (stride 10: kind, pos, size, a, b, r, g, b, i, salt). */
export function packFlare(elements: readonly FlareElement[]): number[] {
	return elements.flatMap((e, k) => [
		KIND_INDEX[e.kind],
		e.pos,
		e.size,
		e.a ?? 0,
		e.b ?? 0,
		e.color[0],
		e.color[1],
		e.color[2],
		e.i,
		k + 1,
	]);
}

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** GLSL constants of one lens: `const int SGL_FLARE_N` and `const float SGL_FLARE[]`. */
export function flareConstGlsl(elements: readonly FlareElement[]): string {
	const data = packFlare(elements);
	return `const int SGL_FLARE_N = ${elements.length};\nconst float SGL_FLARE[${data.length}] = float[${data.length}](${data.map(f).join(', ')});\n`;
}

const FLARE_RENDERER = /* glsl */ `
float sgl_polyDist(vec2 d, float sides, float rot) {
  // Distance-like measure to a regular polygon of unit inradius (1 = on the edge).
  float a = atan(d.y, d.x) - rot;
  float seg = 6.28318530718 / sides;
  float k = cos(floor(0.5 + a / seg) * seg - a);
  return length(d) * k;
}
float sgl_hash1f(float x, float seed) {
  uint h = uint(int(x) + 4096) * 747796405u + uint(seed * 65535.0) * 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return float((h >> 22u) ^ h) / 4294967295.0;
}
// Periodic 1D value noise over n bins of the full circle (starbursts).
float sgl_angleNoise(float ang, float n, float seed) {
  float t = (ang / 6.28318530718 + 0.5) * n;
  float i = floor(t);
  float fr = t - i;
  float a = sgl_hash1f(mod(i, n), seed);
  float b = sgl_hash1f(mod(i + 1.0, n), seed);
  return mix(a, b, smoothstep(0.0, 1.0, fr));
}
vec3 sgl_flareElement(int kind, vec2 d, float size, float pa, float pb, float salt, vec2 axis, float rot) {
  float r = length(d);
  float s = max(size, 1.0e-4);
  if (kind == 0) {
    // glow: core (pa = core ratio) + soft halo
    float x = r / s;
    float core = exp(-x * x / max(pa * pa, 1.0e-4) * 0.5);
    float halo = 1.0 / (1.0 + 16.0 * x * x) * (1.0 - smoothstep(0.6, 1.6, x)) + 0.25 * exp(-3.0 * x);
    return vec3(core * 2.0 + halo);
  }
  if (kind == 1) {
    // ring: width pa, chroma pb (rgb radii split)
    float w = max(pa, 1.0e-4);
    vec3 off = vec3(1.0, 0.0, -1.0) * pb * w;
    vec3 x = (vec3(r) - s - off) / w;
    return exp(-x * x * 2.0);
  }
  if (kind == 2) {
    // rainbow: spectral band of width pa around radius s (red outside)
    float w = max(pa, 1.0e-4);
    float t = (r - s) / w;
    float band = exp(-t * t * 0.5);
    return sgl_spectrum(clamp(0.5 - t * 0.35, 0.0, 1.0)) * band;
  }
  if (kind == 3 || kind == 4) {
    // poly (pa sides, pb rotation degrees) or disc (pa softness): soft ghost with brighter rim
    float x = kind == 3 ? sgl_polyDist(d / s, max(pa, 3.0), radians(pb) + rot) : r / s;
    float soft = kind == 3 ? 0.06 : max(pa, 0.02);
    float fill = 1.0 - smoothstep(1.0 - soft, 1.0, x);
    float rim = exp(-pow((x - 0.96) / 0.05, 2.0)) * 0.6;
    return vec3(fill * (0.35 + 0.65 * x * x) + rim);
  }
  if (kind == 5) {
    // streak: thickness pa, angle pb (degrees, relative to the frame horizontal)
    float a = radians(pb);
    vec2 dir = vec2(cos(a), sin(a));
    float along = dot(d, dir);
    float across = dot(d, vec2(-dir.y, dir.x));
    float th = max(pa, 1.0e-4);
    float ext = 1.0 - smoothstep(0.0, s, abs(along));
    return vec3(exp(-abs(across) / th) * ext * ext * (0.6 + 0.4 * exp(-abs(along) / (0.15 * s))));
  }
  if (kind == 6) {
    // spikes: pa count, pb thickness
    float n = max(pa, 1.0);
    float ang = atan(d.y, d.x) - rot - 0.3;
    float seg = 3.14159265359 * 2.0 / n;
    float m = mod(ang + seg * 0.5, seg) - seg * 0.5;
    float across = abs(sin(m)) * r;
    float th = max(pb, 1.0e-4) * (1.0 + r / s * 2.0);
    float len = max(0.0, 1.0 - r / s);
    return vec3(exp(-across / th) * len * len);
  }
  // burst: pa rays, pb contrast
  float ang = atan(d.y, d.x) - rot;
  float n1 = sgl_angleNoise(ang, max(pa, 4.0), salt * 0.137);
  float n2 = sgl_angleNoise(ang, max(pa, 4.0) * 2.7, salt * 0.291);
  float rays = pow(n1 * 0.6 + n2 * 0.4, 1.0 + pb * 6.0);
  float len = s * (0.35 + 0.65 * n1);
  float fall = exp(-r / max(len * 0.35, 1.0e-4));
  return vec3(rays * fall * 2.0);
}
vec3 sgl_flare(vec2 px, vec2 light, vec2 center, float unit, float scale, float rot, vec3 tint) {
  vec2 axis = center - light;
  vec3 acc = vec3(0.0);
  for (int k = 0; k < SGL_FLARE_N; k++) {
    int o = k * 10;
    int kind = int(SGL_FLARE[o]);
    vec2 p = light + axis * SGL_FLARE[o + 1];
    float size = SGL_FLARE[o + 2] * unit * scale;
    float pa = SGL_FLARE[o + 3];
    float pb = SGL_FLARE[o + 4];
    if (kind == 1 || kind == 2 || kind == 5) pa *= unit * scale;
    if (kind == 6) pb *= unit * scale;
    vec2 d = px - p;
    vec3 col = vec3(SGL_FLARE[o + 5], SGL_FLARE[o + 6], SGL_FLARE[o + 7]) * SGL_FLARE[o + 8];
    acc += sgl_flareElement(kind, d, size, pa, pb, SGL_FLARE[o + 9], axis, rot) * col;
  }
  return acc * tint;
}
`;

/**
 * The flare renderer of one element list: `vec3 sgl_flare(px, light, center, unit, scale, rot, tint)` sums every
 * element (px, light, center in canvas px; unit = frame diagonal in canvas px). One chunk per lens (`name`).
 */
export function flareChunk(name: string, elements: readonly FlareElement[]): GlslChunk {
	return {
		name: `sgl/flare/${name}`,
		deps: [GLSL_SGL_CORE],
		source: flareConstGlsl(elements) + FLARE_RENDERER,
	};
}

export const FLARE_STRIDE = STRIDE;

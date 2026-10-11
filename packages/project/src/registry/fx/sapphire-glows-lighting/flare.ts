// Family-private lens-flare model of the Sapphire Glows + Lighting family: a flare is a list of ELEMENTS placed
// along the flare axis — from the Hotspot (the light) through the Pivot and beyond, like the internal reflections
// of a real lens. Each built-in lens (`FLARE_LENSES`) is one element list; its shader bakes the list as a GLSL const
// array (Lens is a hold-only popup, so the program changes only when the lens does) while every keyframable control
// (hotspot, pivot, brightness, widths, colours, rays…) stays a uniform.
//
// Element kinds (analytic, resolution independent; sizes in frame diagonals × Scale Widths):
//   glow     radial light: a tight core plus a soft halo;
//   ring     a thin ring of radius size (a: width, b: chromatic split → rainbow edge);
//   rainbow  a wide spectral hoop (red outside), a: band width;
//   poly     an iris ghost: a regular polygon (a: sides, b: rotation°), soft edge, brighter rim, faint fill;
//   disc     a soft filled circle ghost (a: softness);
//   streak   an anamorphic line through the element (a: thickness, b: angle°);
//   spikes   a star of thin spikes (a: count, b: thickness);
//   burst    a starburst of many fine random rays (a: ray count, b: contrast).
// Element classes follow Sapphire's controls: elements at the hotspot are "hotspot" elements (Hotspot Bright /
// Hotspot Color), streaks/spikes/bursts are "rays" (Rays Brightness / Num Scale / Length / Thickness / Rays Rotate),
// the rest are "other" elements (Other Brightness / Color / Width).
//
// Lenses: the classic Sapphire lens set is described in Boris FX's documentation (50_300mm_zoom: hotspot with a
// ray cluster, red glow and red ring, plus many elements; 35mm_prime: the same idea, fewer elements; 105mm_prime:
// ray cluster, blue ring, blue glow; anamorphic1: horizontal blue rays, a diagonal blue ray, red glow and ring;
// anamorphic2: horizontal blue rays and a red glow; anamorphicBlue: horizontal and diagonal blue rays with a
// hexagonal blue/white glow; rays_only 1–3: ray clusters only; simple_hex: four red and blue hexagons). The element
// lists below are our own designs after those descriptions, plus a few extra lenses.
import type { ParamValue } from '../../../schema/common.ts';
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
 * One element. `pos`: place along the axis (0 = the hotspot, 1 = the pivot, 2 = mirrored through it; negative =
 * beyond the hotspot). `size`: radius in frame diagonals. `a`, `b`: kind parameters (see above). `color`: RGB
 * tint; `i`: intensity.
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

type C = [number, number, number];
const W: C = [1, 1, 1];
const warm: C = [1, 0.78, 0.5];
const red: C = [1, 0.32, 0.18];
const blue: C = [0.35, 0.55, 1];
const paleBlue: C = [0.7, 0.85, 1];
const green: C = [0.45, 1, 0.55];
const violet: C = [0.7, 0.45, 1];
const amber: C = [1, 0.62, 0.22];
const teal: C = [0.3, 0.9, 0.85];
const rose: C = [1, 0.42, 0.6];

/** Iris ghosts (polygons) along the axis: [pos, size, colour, intensity]. */
const ghosts = (sides: number, rot: number, list: [number, number, C, number][]): FlareElement[] =>
	list.map(([pos, size, color, i]) => ({ kind: 'poly', pos, size, color, i, a: sides, b: rot }));
const discs = (list: [number, number, C, number, number?][]): FlareElement[] =>
	list.map(([pos, size, color, i, soft]) => ({ kind: 'disc', pos, size, color, i, a: soft ?? 0.5 }));

export const FLARE_LENSES: readonly FlareLens[] = [
	{
		value: 'zoom50300',
		label: '50_300mm_zoom',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.11, color: [1, 0.55, 0.4], i: 1.1, a: 0.12 },
			{ kind: 'burst', pos: 0, size: 0.2, color: [1, 0.9, 0.8], i: 0.45, a: 72, b: 0.7 },
			{ kind: 'spikes', pos: 0, size: 0.13, color: W, i: 0.4, a: 6, b: 0.0022 },
			{ kind: 'ring', pos: 0, size: 0.085, color: red, i: 0.22, a: 0.01, b: 0.4 },
			...ghosts(6, 12, [
				[0.22, 0.014, amber, 0.32],
				[0.42, 0.034, green, 0.14],
				[0.62, 0.02, blue, 0.22],
				[0.82, 0.055, violet, 0.09],
				[1.18, 0.028, teal, 0.17],
				[1.38, 0.07, amber, 0.07],
				[1.62, 0.016, rose, 0.3],
				[1.95, 0.1, blue, 0.05],
			]),
			...discs([
				[0.5, 0.008, W, 0.5, 0.3],
				[1.05, 0.04, red, 0.08, 0.7],
				[1.5, 0.012, green, 0.35, 0.4],
			]),
			{ kind: 'ring', pos: 1.7, size: 0.16, color: amber, i: 0.06, a: 0.02, b: 0.6 },
			{ kind: 'rainbow', pos: 2.15, size: 0.24, color: W, i: 0.1, a: 0.025 },
		],
	},
	{
		value: 'prime35',
		label: '35mm_prime',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.1, color: [1, 0.6, 0.45], i: 1, a: 0.12 },
			{ kind: 'burst', pos: 0, size: 0.16, color: [1, 0.9, 0.8], i: 0.4, a: 60, b: 0.6 },
			{ kind: 'ring', pos: 0, size: 0.075, color: red, i: 0.18, a: 0.009, b: 0.3 },
			...ghosts(6, 12, [
				[0.4, 0.028, green, 0.14],
				[0.75, 0.018, blue, 0.22],
				[1.3, 0.05, violet, 0.08],
				[1.7, 0.022, amber, 0.18],
			]),
			{ kind: 'rainbow', pos: 2.1, size: 0.2, color: W, i: 0.08, a: 0.02 },
		],
	},
	{
		value: 'prime105',
		label: '105mm_prime',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.12, color: [0.55, 0.7, 1], i: 1.1, a: 0.1 },
			{ kind: 'burst', pos: 0, size: 0.22, color: paleBlue, i: 0.5, a: 90, b: 0.75 },
			{ kind: 'ring', pos: 0, size: 0.1, color: blue, i: 0.25, a: 0.012, b: 0.2 },
			...discs([
				[0.6, 0.03, blue, 0.1, 0.6],
				[1.4, 0.05, paleBlue, 0.06, 0.8],
			]),
			{ kind: 'ring', pos: 1.8, size: 0.12, color: blue, i: 0.06, a: 0.012, b: 0.2 },
		],
	},
	{
		value: 'anamorphic1',
		label: 'anamorphic1',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.09, color: [1, 0.5, 0.4], i: 1.1, a: 0.15 },
			{ kind: 'streak', pos: 0, size: 0.95, color: blue, i: 0.9, a: 0.0035, b: 0 },
			{ kind: 'streak', pos: 0, size: 0.35, color: paleBlue, i: 0.55, a: 0.0012, b: 0 },
			{ kind: 'streak', pos: 0, size: 0.25, color: blue, i: 0.3, a: 0.0015, b: 35 },
			{ kind: 'ring', pos: 0, size: 0.08, color: red, i: 0.2, a: 0.008, b: 0.3 },
			...discs([
				[0.5, 0.03, blue, 0.12, 0.6],
				[1.4, 0.06, [0.3, 0.45, 1], 0.09, 0.7],
			]),
			{ kind: 'streak', pos: 1.8, size: 0.22, color: blue, i: 0.15, a: 0.0025, b: 0 },
		],
	},
	{
		value: 'anamorphic2',
		label: 'anamorphic2',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.1, color: [1, 0.45, 0.35], i: 1.1, a: 0.15 },
			{ kind: 'streak', pos: 0, size: 1.1, color: blue, i: 1, a: 0.004, b: 0 },
			{ kind: 'streak', pos: 0, size: 0.4, color: paleBlue, i: 0.6, a: 0.0012, b: 0 },
		],
	},
	{
		value: 'anamorphicBlue',
		label: 'anamorphicBlue',
		elements: [
			{ kind: 'poly', pos: 0, size: 0.05, color: paleBlue, i: 0.8, a: 6, b: 0 },
			{ kind: 'glow', pos: 0, size: 0.09, color: [0.6, 0.8, 1], i: 1.1, a: 0.15 },
			{ kind: 'streak', pos: 0, size: 1, color: blue, i: 0.9, a: 0.0035, b: 0 },
			{ kind: 'streak', pos: 0, size: 0.3, color: blue, i: 0.35, a: 0.0015, b: 30 },
			{ kind: 'streak', pos: 0, size: 0.3, color: blue, i: 0.35, a: 0.0015, b: -30 },
			...ghosts(6, 0, [
				[0.6, 0.03, blue, 0.14],
				[1.5, 0.06, paleBlue, 0.08],
			]),
		],
	},
	{
		value: 'raysOnly',
		label: 'rays_only',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.06, color: W, i: 0.8, a: 0.2 },
			{ kind: 'burst', pos: 0, size: 0.3, color: [1, 0.92, 0.85], i: 0.6, a: 110, b: 0.8 },
		],
	},
	{
		value: 'raysOnly2',
		label: 'rays_only2',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.05, color: W, i: 0.8, a: 0.2 },
			{ kind: 'spikes', pos: 0, size: 0.3, color: W, i: 0.55, a: 8, b: 0.0025 },
			{ kind: 'spikes', pos: 0, size: 0.15, color: warm, i: 0.3, a: 16, b: 0.0015 },
		],
	},
	{
		value: 'raysOnly3',
		label: 'rays_only3',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.07, color: warm, i: 0.9, a: 0.2 },
			{ kind: 'burst', pos: 0, size: 0.45, color: warm, i: 0.4, a: 180, b: 1 },
			{ kind: 'spikes', pos: 0, size: 0.22, color: W, i: 0.35, a: 4, b: 0.003 },
		],
	},
	{
		value: 'simpleHex',
		label: 'simple_hex',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.05, color: W, i: 0.7, a: 0.2 },
			...ghosts(6, 0, [
				[0.35, 0.03, red, 0.22],
				[0.7, 0.05, blue, 0.15],
				[1.3, 0.04, red, 0.18],
				[1.75, 0.07, blue, 0.11],
			]),
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
		value: 'rainbowHalo',
		label: 'Rainbow Halo',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.1, color: W, i: 1, a: 0.12 },
			{ kind: 'rainbow', pos: 0, size: 0.18, color: W, i: 0.2, a: 0.03 },
			{ kind: 'rainbow', pos: 1.6, size: 0.3, color: W, i: 0.12, a: 0.05 },
			{ kind: 'ring', pos: 0.7, size: 0.06, color: W, i: 0.1, a: 0.008, b: 1 },
			...discs([[1.2, 0.03, violet, 0.15, 0.5]]),
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
			...discs([
				[0.4, 0.015, teal, 0.3, 0.3],
				[2, 0.05, blue, 0.1, 0.6],
			]),
		],
	},
	{
		value: 'warmSun',
		label: 'Warm Sun',
		elements: [
			{ kind: 'glow', pos: 0, size: 0.28, color: [1, 0.7, 0.35], i: 1.2, a: 0.06 },
			{ kind: 'burst', pos: 0, size: 0.3, color: [1, 0.8, 0.5], i: 0.25, a: 120, b: 0.5 },
			...discs([
				[0.55, 0.06, amber, 0.1, 0.8],
				[1.3, 0.1, [1, 0.5, 0.2], 0.07, 0.8],
			]),
			{ kind: 'ring', pos: 1.9, size: 0.2, color: amber, i: 0.05, a: 0.03, b: 0.5 },
		],
	},
];

/** Element class: 0 hotspot, 1 rays, 2 other. */
const classOf = (e: FlareElement) =>
	e.kind === 'streak' || e.kind === 'spikes' || e.kind === 'burst' ? 1 : Math.abs(e.pos) < 1e-6 ? 0 : 2;

/** The element list as floats (stride 11: kind, class, pos, size, a, b, r, g, b, i, salt). */
export function packFlare(elements: readonly FlareElement[]): number[] {
	return elements.flatMap((e, k) => [
		KIND_INDEX[e.kind],
		classOf(e),
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

function flareConstGlsl(elements: readonly FlareElement[]): string {
	const data = packFlare(elements);
	return `const int SGL_FLARE_N = ${elements.length};\nconst float SGL_FLARE[${data.length}] = float[${data.length}](${data.map(f).join(', ')});\n`;
}

/**
 * Per-class controls of `sgl_flare` (all from params / derived uniforms of the flare effects):
 * cls[k] = (brightness, width) and tint[k] = colour for class k (0 hotspot, 1 rays, 2 other); rays = (num scale,
 * length, thickness, rotate radians); relH = Rel Heights; soft = Blur Flare.
 */
const FLARE_RENDERER = /* glsl */ `
float sgl_polyDist(vec2 d, float sides, float rot) {
  float a = atan(d.y, d.x) - rot;
  float seg = 6.28318530718 / sides;
  return length(d) * cos(floor(0.5 + a / seg) * seg - a);
}
float sgl_hash1f(float x, float seed) {
  uint h = uint(int(x) + 4096) * 747796405u + uint(seed * 65535.0) * 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return float((h >> 22u) ^ h) / 4294967295.0;
}
// Periodic value noise over n bins of the full circle (starbursts).
float sgl_angleNoise(float ang, float n, float seed) {
  float t = (ang / 6.28318530718 + 0.5) * n;
  float i = floor(t);
  float a = sgl_hash1f(mod(i, n), seed);
  float b = sgl_hash1f(mod(i + 1.0, n), seed);
  return mix(a, b, smoothstep(0.0, 1.0, t - i));
}
vec3 sgl_flareElement(int kind, vec2 d, float s, float pa, float pb, float salt, float rot, vec4 rays, float soft) {
  float r = length(d);
  s = max(s, 1.0e-4);
  if (kind == 0) {
    float x = r / s;
    float core = exp(-x * x / max(pa * pa, 1.0e-4) * 0.5);
    float halo = 1.0 / (1.0 + 16.0 * x * x) * (1.0 - smoothstep(0.6, 1.6, x)) + 0.25 * exp(-3.0 * x);
    return vec3(core * 2.0 + halo);
  }
  if (kind == 1) {
    float w = max(pa, 1.0e-4) * (1.0 + soft * 4.0);
    vec3 x = (vec3(r) - s - vec3(1.0, 0.0, -1.0) * pb * w) / w;
    return exp(-x * x * 2.0);
  }
  if (kind == 2) {
    float w = max(pa, 1.0e-4) * (1.0 + soft * 2.0);
    float t = (r - s) / w;
    return sgl_spectrum(clamp(0.5 - t * 0.35, 0.0, 1.0)) * exp(-t * t * 0.5);
  }
  if (kind == 3 || kind == 4) {
    float x = kind == 3 ? sgl_polyDist(d / s, max(pa, 3.0), radians(pb) + rot) : r / s;
    float sf = (kind == 3 ? 0.06 : max(pa, 0.02)) + soft * 0.5;
    float fill = 1.0 - smoothstep(1.0 - sf, 1.0, x);
    float rim = kind == 3 ? exp(-pow((x - 0.95) / (0.05 + soft * 0.2), 2.0)) * 0.7 : 0.0;
    return vec3(fill * (0.3 + 0.7 * x * x) + rim);
  }
  if (kind == 5) {
    float a = radians(pb) + rays.w;
    vec2 dir = vec2(cos(a), sin(a));
    float along = dot(d, dir);
    float across = dot(d, vec2(-dir.y, dir.x));
    float th = max(pa * rays.z, 1.0e-4) * (1.0 + soft * 6.0);
    float len = s * rays.y;
    float ext = 1.0 - smoothstep(0.0, len, abs(along));
    return vec3(exp(-abs(across) / th) * ext * ext * (0.6 + 0.4 * exp(-abs(along) / (0.15 * len))));
  }
  if (kind == 6) {
    float n = max(floor(pa * rays.x + 0.5), 1.0);
    float ang = atan(d.y, d.x) - rot - rays.w - 0.3;
    float seg = 6.28318530718 / n;
    float m = mod(ang + seg * 0.5, seg) - seg * 0.5;
    float len = s * rays.y;
    float th = max(pb * rays.z, 1.0e-4) * (1.0 + r / len * 2.0) * (1.0 + soft * 4.0);
    float l = max(0.0, 1.0 - r / len);
    return vec3(exp(-abs(sin(m)) * r / th) * l * l);
  }
  float n = max(floor(pa * rays.x + 0.5), 4.0);
  float ang = atan(d.y, d.x) - rot - rays.w;
  float n1 = sgl_angleNoise(ang, n, salt * 0.137);
  float n2 = sgl_angleNoise(ang, floor(n * 2.7), salt * 0.291);
  float k = 1.0 + pb * 6.0 / max(rays.z, 0.05) / (1.0 + soft * 4.0);
  float rr = pow(n1 * 0.6 + n2 * 0.4, k);
  float len = s * rays.y * (0.35 + 0.65 * n1);
  return vec3(rr * exp(-r / max(len * 0.35, 1.0e-4)) * 2.0);
}
// The whole flare at px (canvas px). light/pivot canvas px; unit = frame diagonal (canvas px).
vec3 sgl_flare(vec2 px, vec2 light, vec2 pivot, float unit, float scaleW, float relH, vec3 cls[3], vec3 tint[3],
               vec4 rays, float soft) {
  vec2 axis = pivot - light;
  vec3 acc = vec3(0.0);
  for (int k = 0; k < sgl_dyn(SGL_FLARE_N); k++) {
    int o = k * 11;
    int kind = int(SGL_FLARE[o]);
    int c = int(SGL_FLARE[o + 1]);
    vec2 p = light + axis * SGL_FLARE[o + 2];
    float u = unit * scaleW;
    float size = SGL_FLARE[o + 3] * u * cls[c].y;
    float pa = SGL_FLARE[o + 4];
    float pb = SGL_FLARE[o + 5];
    if (kind == 1 || kind == 2 || kind == 5) pa *= u;
    if (kind == 6) pb *= u;
    vec2 d = px - p;
    d.y /= max(relH, 0.01);
    vec3 col = vec3(SGL_FLARE[o + 6], SGL_FLARE[o + 7], SGL_FLARE[o + 8]) * SGL_FLARE[o + 9] * tint[c] * cls[c].x;
    acc += sgl_flareElement(kind, d, size, pa, pb, SGL_FLARE[o + 10], 0.0, rays, soft) * col;
  }
  return acc;
}
`;

/** The flare renderer of one lens (`sgl_flare(...)`), as an include chunk. */
export function flareChunk(lens: FlareLens): GlslChunk {
	return {
		name: `sgl/flare/${lens.value}`,
		deps: [GLSL_SGL_CORE],
		source: flareConstGlsl(lens.elements) + FLARE_RENDERER,
	};
}

export const lensOf = (v: ParamValue | undefined): FlareLens =>
	FLARE_LENSES.find((l) => l.value === v) ?? FLARE_LENSES[0]!;

// Brush Swirl (TL-061): dry-brush strokes along an arc, a spiral, a ring or a slash, after Pachislop's rings/brushSwirl.ts,
// which builds its ribbons on the CPU. Here the vertex shader evaluates the centreline, the pressure and the taper for each
// sample in closed form, so the stroke is a function of its params alone, and a write-on front runs along it. Droplets
// land when the front passes them. `jasper.write-on` paints along a keyframed brush from the clip start (a simulation of
// the path so far); this one is a designed stroke that scrubs exactly.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG_QUAD } from './light-streaks.ts';
import { clamp, GLSL_TLG, hex, num, pct, variationParam } from './shared.ts';

const PATHS = ['arc', 'spiral', 'slash', 'ring'];
/** Samples along a stroke: smooth to the largest radius a title needs. */
const SAMPLES = 200;
const MAX_SPLATS = 120;

/** Stroke geometry, shared by the ribbon and the droplets. */
const STROKE = /* glsl */ `
const float TLG_TAU = 6.28318531;
struct TlgStroke { float t0, t1, off, width, pathLen; int seed; };
TlgStroke tlg_stroke(int j) {
  int n = int(clamp(floor(u_strokes + 0.5), 1.0, 12.0));
  int main0 = (n - 1) / 2;
  bool isMain = j == main0;
  float W = max(tl_px(u_strokeWidth), 1.0);
  float R = max(tl_px(u_radius), 1.0);
  float spacing = tl_px(u_spacing);
  TlgStroke s;
  s.seed = j * 7 + 3;
  float wf = isMain ? 1.0 : 0.45 + 0.5 * tlg_h(j, 60);
  s.t0 = isMain ? 0.0 : 0.15 * tlg_h(j, 61);
  s.t1 = isMain ? 1.0 : 1.0 - 0.3 * tlg_h(j, 62);
  s.off = (float(j) - float(n - 1) * 0.5) * spacing + (isMain ? 0.0 : (tlg_h(j, 63) - 0.5) * 0.3 * spacing);
  s.width = W * wf;
  float sweep = radians(max(u_sweep, 1.0));
#if TLG_PATH == 2
  s.pathLen = 2.0 * R;
#elif TLG_PATH == 3
  s.pathLen = (TLG_TAU + 0.4) * R;
#elif TLG_PATH == 1
  s.pathLen = sweep * R * 0.65;
#else
  s.pathLen = sweep * R;
#endif
  return s;
}
// The centreline at path parameter t, off px to the side, relative to the centre.
vec2 tlg_pathPoint(float t, float off) {
  float R = max(tl_px(u_radius), 1.0);
  float a0 = radians(u_angle);
#if TLG_PATH == 2
  vec2 ux = vec2(cos(a0), sin(a0));
  float s = R * (2.0 * t - 1.0);
  float n = off + 0.06 * R * sin(3.14159265 * t);
  return ux * s + vec2(-ux.y, ux.x) * n;
#elif TLG_PATH == 3
  float th = a0 + (TLG_TAU + 0.4) * t;
  return (R + off) * (1.0 + 0.05 * t) * vec2(cos(th), sin(th));
#elif TLG_PATH == 1
  float th = a0 + radians(max(u_sweep, 1.0)) * t;
  return (R + off) * (1.0 - 0.7 * t) * vec2(cos(th), sin(th));
#else
  float th = a0 + radians(max(u_sweep, 1.0)) * t;
  return (R + off) * vec2(cos(th), sin(th));
#endif
}
// A sample of stroke s at u: the hand wobbles sideways by about a tenth of the width.
vec2 tlg_sample(TlgStroke s, float u) {
  float wob = 0.2 * s.width * (tlg_noise1(u * 5.0, s.seed) - 0.5);
  return tlg_pathPoint(mix(s.t0, s.t1, u), s.off + wob);
}
// Half width at u: the press-in swells fast, the lift-off thins out over a long tail, both ends close round.
float tlg_halfWidth(TlgStroke s, float u) {
  float tin = clamp(u_taperIn * 0.01, 0.0, 1.0), tout = clamp(u_taperOut * 0.01, 0.0, 1.0);
  float inStart = 1.0 - 0.9 * tin, inLen = 0.03 + 0.3 * tin;
  float outEnd = 1.0 - 0.95 * tout, outLen = 0.03 + 0.5 * tout;
  float e = 1.0 - min(1.0, u / inLen);
  float swell = inStart + (1.0 - inStart) * (1.0 - e * e);
  float lift = outEnd + (1.0 - outEnd) * pow(min(1.0, (1.0 - u) / outLen), 0.8);
  float hw = 0.5 * s.width * swell * lift * (0.8 + 0.4 * tlg_noise1(u * 3.0, s.seed + 1));
  float total = (s.t1 - s.t0) * s.pathLen;
  float a = 1.0 - min(1.0, u * total / max(hw, 1.0e-3));
  float b = 1.0 - min(1.0, (1.0 - u) * total / max(hw, 1.0e-3));
  return hw * sqrt(max(0.0, 1.0 - a * a)) * sqrt(max(0.0, 1.0 - b * b));
}
// How far along its stroke the write-on front is, 0..1 and past.
float tlg_front(int j) {
  float p = clamp(u_writeOn * 0.01, 0.0, 1.0);
  if (u_writeTime > 0.0) p *= clamp(u_tlTime / u_writeTime, 0.0, 1.0);
  int n = int(clamp(floor(u_strokes + 0.5), 1.0, 12.0));
  float delay = n > 1 ? 0.2 * tlg_h(j, 64) : 0.0;
  return p >= 1.0 ? 1.1 : (p - delay) / (1.0 - delay) * 1.1;
}
`;

const dropletsOf = (p: LayerParams) => Math.round((clamp(num(p.splatter), 0, 100) / 100) * MAX_SPLATS);

const reachOf = (p: LayerParams) => {
	const R = Math.max(1, num(p.radius));
	const n = Math.round(clamp(num(p.strokes), 1, 12));
	const W = Math.max(0.5, num(p.strokeWidth));
	const ink = 1.06 * R + 0.5 * (n - 1) * Math.abs(num(p.spacing)) * 1.15 + 0.75 * W;
	return ink + (num(p.splatter) > 0 ? 3.4 * W : 0) + 2;
};

export const GENERATOR_BRUSH_SWIRL = defineGenerator({
	id: 'brushSwirl',
	label: 'Brush Swirl',
	description:
		'Dry-brush strokes writing on along an arc, a spiral, a ring or a slash, with bristle gaps and droplets.',
	keywords: ['brush', 'ink', 'stroke', 'calligraphy', 'write on', 'swirl'],
	params: [
		lp.choice('path', 'Path', PATHS, ['Arc', 'Spiral', 'Slash', 'Ring'], 'arc'),
		lp.point('center', 'Centre', [0.5, 0.5]),
		lp.distance('radius', 'Radius', 190, { min: 1, softMax: 800 }),
		lp.number('sweep', 'Sweep', 300, { min: 10, max: 1080, step: 0.1 }, { unit: 'deg' }),
		lp.angle('angle', 'Start Angle', -150),
		lp.number('strokes', 'Strokes', 4, { min: 1, max: 12, step: 1 }),
		lp.distance('spacing', 'Stroke Spacing', 13, { softMax: 200 }),
		lp.distance('strokeWidth', 'Width', 35, { min: 0.5, softMax: 300 }),
		lp.percent('taperIn', 'Taper In', 15),
		lp.percent('taperOut', 'Taper Out', 85),
		lp.percent('dry', 'Dry Brush', 45),
		lp.percent('splatter', 'Splatter', 30),
		lp.percent('writeOn', 'Write On', 100),
		lp.number('writeTime', 'Write Time', 0, { min: 0, max: 60, softMax: 5, step: 0.01 }, { unit: 's' }),
		lp.color('color', 'Colour', hex('#0b0907')),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	color: { role: 'accent1', mode: 'flat' },
	defines: (p) =>
		`#define TLG_PATH ${Math.max(0, PATHS.indexOf(String(p.path)))}\n#define TLG_BRUSH_DROPLETS ${dropletsOf(p) > 0 ? 1 : 0}\n`,
	presets: [
		{ id: 'ink', label: 'Ink Swirl', params: {} },
		{
			id: 'gold',
			label: 'Gold Spiral',
			params: {
				path: 'spiral',
				radius: 210,
				sweep: 420,
				angle: -120,
				strokes: 3,
				spacing: 17,
				strokeWidth: 32,
				taperIn: 20,
				taperOut: 90,
				dry: 55,
				splatter: 25,
				writeTime: 1.2,
				color: hex('#d9a030'),
			},
		},
		{
			id: 'ring',
			label: 'Red Ring',
			params: {
				path: 'ring',
				radius: 180,
				angle: 130,
				strokes: 2,
				spacing: 9,
				strokeWidth: 42,
				taperIn: 10,
				taperOut: 70,
				dry: 40,
				splatter: 35,
				writeTime: 1,
				color: hex('#d0121a'),
			},
		},
		{
			id: 'slash',
			label: 'Slash',
			params: {
				path: 'slash',
				radius: 280,
				angle: -18,
				strokes: 3,
				spacing: 6,
				strokeWidth: 25,
				taperIn: 90,
				taperOut: 95,
				dry: 50,
				splatter: 20,
				writeTime: 0.5,
				color: hex('#fff8ec'),
			},
		},
	],
	reach: reachOf,
	fieldReach: () => ({ outside: 1 }),
	timeDependent: (p) => num(p.writeTime) > 0,
	summary: (p) => `${String(p.path)}, ${pct(p.radius)}`,
	prepass: (p, c) => {
		const strokes = Math.round(clamp(num(p.strokes), 1, 12));
		const droplets = dropletsOf(p);
		const passes = [
			c.pass({
				output: 'tlGenA',
				format: 'rgba16f',
				include: [GLSL_UV],
				draw: {
					vertices: (SAMPLES - 1) * 6,
					instances: strokes,
					blend: 'over',
					vert: /* glsl */ `${STROKE}
out vec2 v_u;       // along 0..1, px across from the centreline
out vec4 v_info;    // arc length px, half width px, stroke seed, stroke width px
flat out float v_front;
void main() {
  tlg_begin();
  TlgStroke s = tlg_stroke(gl_InstanceID);
  int quad = gl_VertexID / 6;
  int v = gl_VertexID % 6;
  bool far1 = v == 1 || v == 4 || v == 5;
  float side = (v == 2 || v == 3 || v == 5) ? 1.0 : -1.0;
  float k = float(quad + (far1 ? 1 : 0));
  float u = k / ${SAMPLES - 1}.0;
  float du = 1.0 / ${SAMPLES - 1}.0;
  vec2 c = fx_canvasPxOfLayerNorm(u_center);
  vec2 p = tlg_sample(s, u);
  vec2 d = tlg_sample(s, min(u + du, 1.0)) - tlg_sample(s, max(u - du, 0.0));
  vec2 t = length(d) > 1.0e-5 ? normalize(d) : vec2(1.0, 0.0);
  float hw = tlg_halfWidth(s, u);
  float e = hw + 1.5;
  v_u = vec2(u, e * side);
  v_info = vec4(u * (s.t1 - s.t0) * s.pathLen, hw, tlg_h(gl_InstanceID, 65) * 100.0, s.width);
  v_front = tlg_front(gl_InstanceID);
  fx_emit(c + p + vec2(-t.y, t.x) * e * side);
}`,
				},
				frag: /* glsl */ `
in vec2 v_u;
in vec4 v_info;
flat in float v_front;
void main() {
  tlg_begin();
  float u = v_u.x, across = v_u.y;
  float len = v_info.x, hw = max(v_info.y, 1.0e-3), seed = v_info.z, W = max(v_info.w, 1.0);
  float sn = across / hw;
  float s = abs(sn);
  // Hairs: clumps across the stroke, stretched far along it, with finer single hairs inside them.
  float f = 8.0;
  float b1 = tlg_vnoise(vec2(sn * f * 0.5 + seed * 31.0, len / (4.0 * W)));
  float b2 = tlg_vnoise(vec2(sn * f * 2.3 + seed * 17.0, len / (1.5 * W)));
  float b = 0.6 * b1 + 0.4 * b2;
  // A ragged rim: the outermost hairs straggle.
  float rim = 1.0 - 0.08 * tlg_vnoise(vec2(len / (0.3 * W), seed * 13.0)) - 0.08 * tlg_vnoise(vec2(len / (0.06 * W), seed * 7.0 + 3.0));
  float cov = clamp((rim * hw - abs(across)) / max(fwidth(across), 1.0e-4) + 0.5, 0.0, 1.0);
  // Dry brush: hairs run out of ink toward the tail and on the rims first, with dry patches where the brush skipped.
  float dry = clamp(u_dry * 0.01, 0.0, 1.0);
  float skip = tlg_vnoise(vec2(len / (1.2 * W), seed * 5.0 + 11.0));
  float thr = dry * ((0.35 + 0.9 * pow(u, 1.2)) * (0.75 + 0.6 * s * s) + 0.5 * (skip - 0.5));
  float bs = clamp((b - 0.5) * 2.4 + 0.5, 0.0, 1.0);
  float aw = max(0.04, fwidth(bs));
  float ink = dry > 0.0 ? smoothstep(thr - aw, thr + aw, bs) : 1.0;
  // The write-on front: the brush tip is round, and it carries its own small bleed.
  float front = 1.0 - smoothstep(v_front - 0.02, v_front, u + 0.02 * (b - 0.5));
  float a = cov * ink * (0.94 + 0.06 * b1) * front;
  fragColor = vec4(tlg_rgb(u_color) * (0.45 + 1.1 * b2) * a, a);
}`,
			}),
		];
		if (droplets > 0)
			passes.push(
				c.pass({
					output: 'tlGenB',
					format: 'rgba16f',
					include: [GLSL_UV, GLSL_TLG_QUAD],
					draw: {
						vertices: 6,
						instances: droplets,
						blend: 'over',
						vert: /* glsl */ `${STROKE}
out vec2 v_q;
flat out float v_n;
void main() {
  tlg_begin();
  int i = gl_InstanceID;
  int n = int(clamp(floor(u_strokes + 0.5), 1.0, 12.0));
  int j = int(tlg_h(i, 70) * float(n)) % n;
  TlgStroke s = tlg_stroke(j);
  float W = s.width;
  float u;
  float d = W * (0.04 + 0.22 * pow(tlg_h(i, 71), 3.0));
  vec2 c = fx_canvasPxOfLayerNorm(u_center);
  vec2 at, t;
  if (tlg_h(i, 72) < 0.7) {
    // Sprayed off a side, more toward the fast tail.
    u = pow(tlg_h(i, 73), 0.7);
    vec2 g = tlg_sample(s, min(u + 0.01, 1.0)) - tlg_sample(s, max(u - 0.01, 0.0));
    t = length(g) > 1.0e-5 ? normalize(g) : vec2(1.0, 0.0);
    float sideOf = tlg_h(i, 74) < 0.5 ? -1.0 : 1.0;
    float dist = tlg_halfWidth(s, u) + W * (0.08 + 1.4 * pow(tlg_h(i, 75), 2.0));
    at = tlg_sample(s, u) + vec2(-t.y, t.x) * dist * sideOf + t * (tlg_h(i, 76) - 0.5) * 0.6 * W;
  } else {
    // Flicked on past the end of the stroke.
    u = 1.0;
    vec2 g = tlg_sample(s, 1.0) - tlg_sample(s, 0.98);
    t = length(g) > 1.0e-5 ? normalize(g) : vec2(1.0, 0.0);
    at = tlg_sample(s, 1.0) + t * W * (0.3 + 2.2 * tlg_h(i, 77)) + vec2(-t.y, t.x) * (tlg_h(i, 78) - 0.5) * 0.5 * W;
    d *= 0.7;
  }
  if (tlg_front(j) < u) { fx_cull(); return; }
  float stretch = tlg_h(i, 79) < 0.35 ? 1.5 + 2.0 * tlg_h(i, 80) : 1.0;
  vec2 q = tlg_corner(gl_VertexID);
  v_q = q;
  v_n = tlg_h(i, 81) * 100.0;
  vec2 l = q * vec2(d * stretch, d);
  fx_emit(c + at + t * l.x + vec2(-t.y, t.x) * l.y);
}`,
					},
					frag: /* glsl */ `
in vec2 v_q;
flat in float v_n;
void main() {
  tlg_begin();
  float d = length(v_q) + 0.22 * (tlg_vnoise(v_q * 2.5 + v_n) - 0.5);
  float a = clamp((0.8 - d) / max(fwidth(d), 1.0e-3) + 0.5, 0.0, 1.0);
  fragColor = vec4(tlg_rgb(u_color) * a, a);
}`,
				}),
			);
		return passes;
	},
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) {
  vec4 a = texture(u_tlGenA, s.uv);
#if TLG_BRUSH_DROPLETS
  a += texture(u_tlGenB, s.uv) * (1.0 - a.a);
#endif
  return a;
}`,
});

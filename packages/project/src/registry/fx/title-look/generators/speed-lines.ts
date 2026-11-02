// Speed Lines (TL-061): tapered wedges around a clean focus, after Pachislop's lines/speedLines.ts: focus lines, flow
// lines, flash spikes and the filled "beta" flash. Pachislop lays lines out on the CPU from tables of the focus boundary;
// here each line is a closed form of its index in the vertex shader. The boundary is analytic for an ellipse or a
// rectangle, and for the title it is found by sphere tracing the shared field from outside, so the focus hole follows the
// shape. Motion: Boil re-rolls the lines every held step (the drawn-animation look), Flow slides them along themselves.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG_QUAD } from './light-streaks.ts';
import { boilParams, GLSL_TLG, hex, num, pct, variationParam } from './shared.ts';

const MAX_LINES = 600;
const TYPES = ['focus', 'flow', 'flash', 'beta'];
/** Segments of a curved line. */
const CURVED_SEGMENTS = 16;

const curved = (p: LayerParams) => num(p.curve) !== 0;

const EXIT = /* glsl */ `
// The focus boundary along a unit ray from c, px from c; 0 = c is outside the focus.
float tlg_focusExit(vec2 c, vec2 dir, float maxT) {
  float rx = max(tl_px(u_rx), 1.0e-3), ry = max(tl_px(u_ry), 1.0e-3);
#if TLG_FOCUS == 0
  return 1.0 / sqrt(dir.x * dir.x / (rx * rx) + dir.y * dir.y / (ry * ry));
#elif TLG_FOCUS == 1
  return min(rx / max(abs(dir.x), 1.0e-5), ry / max(abs(dir.y), 1.0e-5));
#else
  // The title: sphere trace the field inward from outside, the first hit is the outer silhouette along this ray.
  float pad = tl_px(u_padding);
  float t = maxT;
  for (int i = 0; i < 20; i++) {
    float d = tlg_d((c + dir * t) / u_canvasSize) - pad;
    if (d <= 0.5) return t;
    t -= max(d, maxT / 20.0);
    if (t <= 0.0) break;
  }
  return 0.0;
#endif
}
vec2 tlg_focusCentre() {
  #if TLG_FOCUS == 2
  vec4 b = tl_bounds();
  return 0.5 * (b.xy + b.zw) + (u_center - 0.5) * u_box.zw;
  #else
  return u_box.xy + u_center * u_box.zw;
  #endif
}
float tlg_jag(float u, float count, float height) {
  if (count <= 0.0) return 0.0;
  float f = fract(u * count);
  return height * (1.0 - abs(2.0 * f - 1.0));
}
`;

export const GENERATOR_SPEED_LINES = defineGenerator({
	id: 'speedLines',
	label: 'Speed Lines',
	description:
		'Focus lines, flow lines, flash spikes and burst fills around a clean focus, boiling or flowing.',
	keywords: ['manga', 'comic', 'focus lines', 'action', 'flash', 'anime', 'flow'],
	params: [
		lp.choice('kind', 'Type', TYPES, ['Focus Lines', 'Flow Lines', 'Flash', 'Burst Fill'], 'focus'),
		lp.point('center', 'Centre', [0.5, 0.5]),
		lp.choice(
			'focus',
			'Focus Shape',
			['ellipse', 'rect', 'title'],
			['Ellipse', 'Rectangle', 'Title'],
			'title',
		),
		lp.distance('padding', 'Padding', 20, { softMax: 200 }),
		lp.distance('rx', 'Focus Radius X', 210, { softMax: 800 }),
		lp.distance('ry', 'Focus Radius Y', 130, { softMax: 800 }),
		lp.angle('flowAngle', 'Flow Angle', 0),
		lp.choice(
			'flowSide',
			'Flow Side',
			['both', 'ahead', 'behind'],
			['Both Sides', 'Ahead', 'Behind'],
			'both',
		),
		lp.number('count', 'Line Count', 160, { min: 4, max: MAX_LINES, softMax: 400, step: 1 }),
		lp.distance('lineWidth', 'Width', 5, { min: 0.1, softMax: 60 }),
		lp.percent('widthRandom', 'Width Random', 60),
		lp.number('length', 'Length', 100, { min: 1, max: 300, step: 1 }, { unit: '%' }),
		lp.percent('lengthRandom', 'Length Random', 0),
		lp.distance('jitter', 'Base Jitter', 30, { softMax: 200 }),
		lp.number('jagCount', 'Jagged Teeth', 0, { min: 0, max: 64, step: 1 }),
		lp.distance('jagHeight', 'Jag Height', 20, { softMax: 200 }),
		lp.number('clump', 'Clumping', 1, { min: 1, max: 20, step: 1 }),
		lp.number('gap', 'Gap', 0, { min: 0, max: 10, step: 0.1 }),
		lp.percent('taperIn', 'Taper Focus End', 100),
		lp.percent('taperOut', 'Taper Far End', 0),
		lp.number('curve', 'Curve', 0, { min: -100, max: 100, step: 1 }, { unit: '%' }),
		lp.choice(
			'colorMode',
			'Fill',
			['solid', 'length', 'around'],
			['Solid', 'Base to Tip', 'Around'],
			'solid',
		),
		lp.color('color', 'Colour', hex('#ffffff')),
		lp.color('color2', 'Colour 2', hex('#ffc83a')),
		lp.percent('lineOpacity', 'Line Opacity', 85),
		lp.choice('motion', 'Motion', ['still', 'boil', 'flow'], ['Still', 'Boil', 'Flow'], 'boil'),
		...boilParams(12),
		lp.number('flowSpeed', 'Flow Speed', 1.5, { min: -20, max: 20, softMin: 0, softMax: 6, step: 0.01 }),
		lp.distance('extent', 'Extent', 240, { min: 10, softMax: 1000 }),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	shapeAware: true,
	standIn: 'disc',
	usesBounds: () => true,
	color: { role: 'accent2', mode: 'luma' },
	defines: (p) =>
		`#define TLG_KIND ${Math.max(0, TYPES.indexOf(String(p.kind)))}\n#define TLG_FOCUS ${p.focus === 'rect' ? 1 : p.focus === 'title' ? 2 : 0}\n#define TLG_SEGMENTS ${curved(p) ? CURVED_SEGMENTS : 1}\n`,
	presets: [
		{ id: 'focus', label: 'Focus Lines', params: {} },
		{
			id: 'red',
			label: 'Red Focus Lines',
			params: {
				count: 220,
				lineWidth: 7,
				jitter: 45,
				colorMode: 'length',
				color: hex('#fff0a0'),
				color2: hex('#d00c00'),
				lineOpacity: 100,
			},
		},
		{
			id: 'flow',
			label: 'Flow Lines',
			params: {
				kind: 'flow',
				focus: 'ellipse',
				rx: 190,
				ry: 75,
				count: 170,
				lineWidth: 2.5,
				widthRandom: 70,
				lengthRandom: 35,
				jitter: 80,
				motion: 'flow',
			},
		},
		{
			id: 'flash',
			label: 'Flash',
			params: {
				kind: 'flash',
				focus: 'ellipse',
				rx: 130,
				ry: 130,
				count: 300,
				lineWidth: 1.5,
				widthRandom: 50,
				length: 70,
				lengthRandom: 60,
				jitter: 0,
				taperIn: 15,
				taperOut: 100,
				lineOpacity: 100,
			},
		},
		{
			id: 'burst',
			label: 'Burst Fill',
			params: {
				kind: 'beta',
				focus: 'ellipse',
				rx: 120,
				ry: 120,
				count: 140,
				lineWidth: 6,
				widthRandom: 60,
				length: 120,
				lengthRandom: 70,
				jitter: 0,
				taperIn: 0,
				taperOut: 100,
				color: hex('#0c0c14'),
				lineOpacity: 100,
			},
		},
	],
	reach: (p) => num(p.extent),
	fieldReach: (p) => (p.focus === 'title' ? { outside: num(p.padding) + 4 } : { outside: 1 }),
	timeDependent: (p) => p.motion !== 'still',
	summary: (p) => `${String(p.kind)}, ${Math.round(num(p.count))} lines, ${pct(p.lineWidth)}`,
	prepass: (p, c) => [
		c.pass({
			output: 'tlGenA',
			format: 'rgba16f',
			include: [GLSL_UV, GLSL_TLG_QUAD],
			draw: {
				vertices: 6 * (curved(p) ? CURVED_SEGMENTS : 1),
				instances: Math.round(Math.min(MAX_LINES, Math.max(4, num(p.count)))) * 2,
				blend: 'over',
				vert: /* glsl */ `${EXIT}
out vec3 v_t;        // along 0..1, px across, ribbon half extent
flat out vec4 v_l;   // half width px (negative: no focus end), length px, flow fade, around 0..1
int tlg_step = 0;
float tlg_r(int i, int k) { return tlg_h3(i, tlg_step, k); }
vec2 tlg_arc(vec2 p, float h, float kappa, float s) {
  if (abs(kappa * s) < 1.0e-6) return p + vec2(cos(h), sin(h)) * s;
  return p + vec2(sin(h + kappa * s) - sin(h), cos(h) - cos(h + kappa * s)) / kappa;
}
float tlg_frameExit(vec2 p, vec2 d) {
  vec2 t = (mix(vec2(0.0), u_canvasSize, step(0.0, d)) - p) / (abs(d) + 1.0e-6) * sign(d + 1.0e-9);
  return max(min(t.x, t.y), 0.0);
}
void main() {
  tlg_begin();
  // Hold-frame boil: a step number re-rolls the lines; between steps nothing moves.
  if (u_motion == 1) tlg_step = int(floor(u_tlTime * max(u_boilRate, 0.1)));
  int side = gl_InstanceID % 2;
  int i = gl_InstanceID / 2;
  float n = max(4.0, floor(u_count + 0.5));
  float kc = max(1.0, floor(u_clump + 0.5));
  float gap = clamp(u_gap, 0.0, 10.0);
  float bundles = ceil(n / kc);
  float units = n + bundles * gap;
  float b = floor(float(i) / kc);
  float u = (float(i) + b * gap + 0.5 * gap + 0.15 + 0.7 * tlg_r(i, 1)) / units;
  float wr = u_widthRandom * 0.01, lr = u_lengthRandom * 0.01;
  float bundleLen = tlg_r(int(b) + 7000, 2);
  float lenK = 1.0 - lr * (kc > 1.0 ? 0.6 * bundleLen + 0.4 * tlg_r(i, 3) : tlg_r(i, 3));
  float halfW = 0.5 * tl_px(u_lineWidth) * (1.0 - wr * tlg_r(i, 4));
  float jag = tl_px(u_jagHeight);
  float jitter = tl_px(u_jitter) * tlg_r(i, 5);
  float len = max(u_length * 0.01, 0.0);
  vec2 c = tlg_focusCentre();
  float diag = length(u_canvasSize);
  float kappa = (clamp(u_curve, -100.0, 100.0) * 0.01 * 1.0471976) / max(diag * 0.5, 1.0);
  float over = tl_px(u_lineWidth) + 2.0;
  vec2 start;
  float h, L, around = 0.0;
  float hw = halfW;
  bool flowFree = false;
#if TLG_KIND != 1
  if (side == 1) { fx_cull(); return; }
  float au = fract(u + tlg_h(0, 9));
  around = au;
  h = FX_TAU * au;
  vec2 d = vec2(cos(h), sin(h));
  float fr = tlg_frameExit(c, d);
  float rf = tlg_focusExit(c, d, fr);
  float rb = rf + tlg_jag(au, floor(u_jagCount + 0.5), jag) + jitter;
#if TLG_KIND == 0
  // Focus lines run past the frame edge; a shorter length gives up the focus end, so the frame stays swept.
  float total = max(fr - rb, 0.0) + over;
  L = total * len * lenK;
  start = c + d * (rb + total - L);
#else
  // Flash spikes: a share of the focus radius.
  L = max(rf, tl_px(10.0)) * len * lenK;
  start = c + d * rb;
#endif
#else
  // Flow lines: parallel, across the frame, from the focus to the frame edge on either side.
  vec2 dir = fx_dir(u_flowAngle);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 ext = u_canvasSize * 0.5;
  float vr = abs(perp.x) * ext.x + abs(perp.y) * ext.y;
  float v = (u * 2.0 - 1.0) * vr;
  vec2 o = u_canvasSize * 0.5 + perp * v;
  around = u;
  // The chord of the focus at this line: how far the focus reaches along it, from its point nearest the centre.
  float offset = dot(o - c, dir);
  vec2 foot = o - dir * offset;
  float reachF = tlg_focusExit(foot, dir, length(ext));
#if TLG_FOCUS == 0
  float rv = dot(foot - c, perp);
  float rx = max(tl_px(u_rx), 1.0e-3), ry = max(tl_px(u_ry), 1.0e-3);
  float e = 1.0 - rv * rv / (dot(perp, vec2(rx, 0.0)) * dot(perp, vec2(rx, 0.0)) + dot(perp, vec2(0.0, ry)) * dot(perp, vec2(0.0, ry)));
  reachF = e > 0.0 ? reachF * sqrt(e) : 0.0;
#endif
  if (reachF <= 0.0) {
    if (side == 1 || u_flowSide != 0) { fx_cull(); return; }
    // Past the focus a line sweeps the whole frame: it has no focus end for Length Random to shorten.
    flowFree = true;
    h = atan(dir.y, dir.x);
    float back = tlg_frameExit(o, -dir) + over;
    float total = back + tlg_frameExit(o, dir) + over;
    L = total * min(1.0, len);
    start = o - dir * back + dir * (total - L) * tlg_r(i, 6);
  } else {
    float sd = side == 0 ? 1.0 : -1.0;
    if ((u_flowSide == 1 && sd < 0.0) || (u_flowSide == 2 && sd > 0.0)) { fx_cull(); return; }
    vec2 dd = dir * sd;
    h = atan(dd.y, dd.x);
    float rb = reachF + tlg_jag(u, floor(u_jagCount + 0.5), jag) + jitter;
    vec2 base = foot + dd * rb;
    float total = tlg_frameExit(base, dd) + over;
    L = total * len * lenK;
    start = base + dd * (total - L);
    if (dot(base - u_canvasSize * 0.5, dd) > length(ext)) { fx_cull(); return; }
  }
#endif
  if (L < 0.5) { fx_cull(); return; }
  float flowFade = 1.0;
  if (u_motion == 2) {
    // Flow: each line is a dash sliding along itself, wrapping unseen at the ends of its run.
    float f = fract(tlg_r(i, 7) + u_tlTime * u_flowSpeed * (0.6 + 0.8 * tlg_r(i, 8)));
    float dash = L * 0.45;
    flowFade = smoothstep(0.0, 0.2, f) * (1.0 - smoothstep(0.8, 1.0, f));
    start += vec2(cos(h), sin(h)) * (L - dash) * f;
    L = dash;
    flowFree = true;
  }
  int seg = gl_VertexID / 6;
  vec2 q = tlg_corner(gl_VertexID);
  float s0 = float(seg) / float(TLG_SEGMENTS), s1 = float(seg + 1) / float(TLG_SEGMENTS);
  float t = mix(s0, s1, 0.5 + 0.5 * q.x);
  vec2 a = tlg_arc(start, h, kappa, L * s0), e1 = tlg_arc(start, h, kappa, L * s1);
  vec2 ux = normalize(e1 - a + vec2(1.0e-5, 0.0));
  float m0 = seg == 0 ? 1.5 : 0.0, m1 = seg == TLG_SEGMENTS - 1 ? 1.5 : 0.0;
  a -= ux * m0;
  e1 += ux * m1;
  float tt = mix(s0 - m0 / L, s1 + m1 / L, 0.5 + 0.5 * q.x);
  float halfExt = max(hw, 0.5) + 1.0;
  v_t = vec3(tt, q.y * halfExt, halfExt);
  v_l = vec4(flowFree ? -hw : hw, L, flowFade, around);
  vec2 centre = mix(a, e1, 0.5 + 0.5 * q.x);
  fx_emit(centre + vec2(-ux.y, ux.x) * q.y * halfExt);
}`,
			},
			frag: /* glsl */ `
in vec3 v_t;
flat in vec4 v_l;
float tlg_taper(float t, float tail, float head) {
  float w = 1.0;
  if (tail > 0.0) w = min(w, t / tail);
  if (head > 0.0) w = min(w, (1.0 - t) / head);
  return clamp(w, 0.0, 1.0);
}
void main() {
  float t = v_t.x;
  float tail = u_taperIn * 0.01, head = u_taperOut * 0.01;
  float sum = tail + head;
  if (sum > 1.0) { tail /= sum; head /= sum; }
  float hw = abs(v_l.x) * tlg_taper(clamp(t, 0.0, 1.0), v_l.x < 0.0 ? head : tail, head);
  float x = abs(v_t.y);
  // Sub-pixel widths keep a 1 px footprint and fade by their true width: hairlines, not dashes.
  float cov = clamp(max(hw, 0.5) - x + 0.5, 0.0, 1.0) * min(1.0, 2.0 * hw);
  cov *= clamp(t * v_l.y + 0.5, 0.0, 1.0) * clamp((1.0 - t) * v_l.y + 0.5, 0.0, 1.0);
  vec3 c = tlg_rgb(u_color);
  if (u_colorMode == 1) c = mix(c, tlg_rgb(u_color2), clamp(t, 0.0, 1.0));
  else if (u_colorMode == 2) c = mix(c, tlg_rgb(u_color2), 0.5 - 0.5 * cos(v_l.w * 6.28318531));
  float a = cov * (u_lineOpacity * 0.01) * v_l.z;
  fragColor = vec4(c * a, a);
}`,
		}),
	],
	glsl: /* glsl */ `${EXIT}
vec4 tl_generate(TlSurface s) {
  vec4 lines = texture(u_tlGenA, s.uv);
#if TLG_KIND == 3
  // The burst fill: the spikes and the focus cut out of a fill of the frame.
  tlg_begin();
  vec2 c = tlg_focusCentre();
  vec2 d = s.px - c;
  float r = length(d);
  vec2 dir = r > 1.0e-3 ? d / r : vec2(1.0, 0.0);
  float rf = tlg_focusExit(c, dir, length(u_canvasSize));
  float au = fract(atan(d.y, d.x) / FX_TAU);
  float hole = clamp(rf + tlg_jag(au, floor(u_jagCount + 0.5), tl_px(u_jagHeight)) - r + 0.5, 0.0, 1.0);
  float cov = 1.0 - max(lines.a, hole);
  vec3 col = tlg_rgb(u_color);
  if (u_colorMode == 1) col = mix(col, tlg_rgb(u_color2), clamp((r - rf) / max(length(u_canvasSize) * 0.5 - rf, 1.0), 0.0, 1.0));
  float a = cov * u_lineOpacity * 0.01;
  return vec4(col * a, a);
#else
  return lines;
#endif
}`,
});

// Lightning (TL-061, TL-062): electric arcs shooting from and crawling over the edges of the shape, after Pachislop's
// energy/lightning.ts, which walks a CPU list of edge cells. Here a bolt is a closed form of its index: its ends are stable
// sites on the shared field, its body a sum of 1D noise octaves (midpoint displacement in closed form), and each segment a
// capsule in a draw pass, so no list of the shape is ever built. Two motions: Boil holds each jag for a frame count and
// re-strikes bolts on a beat, Crawl slides the noise along the bolt continuously. `jasper.lightning` and `jasper.s.zap`
// are bolts between two points; this one lives on the title's edges.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG_QUAD } from './light-streaks.ts';
import {
	anchorParam,
	boilParams,
	GLSL_TLG,
	GLSL_TLG_SITES,
	hex,
	num,
	pct,
	variationParam,
} from './shared.ts';

const MODES = ['mixed', 'outward', 'crawl', 'edge'];
/** Segments of one path. */
const SEGMENTS = 40;
/** Paths per bolt: the bolt and its possible branches. */
const PER_BOLT = 4;

const edgeMode = (p: LayerParams) => p.mode === 'edge';
const boltCount = (p: LayerParams) =>
	Math.round(Math.min(60, Math.max(1, edgeMode(p) ? num(p.arcs) : num(p.count))));

const reachOf = (p: LayerParams) => {
	const glow = 3 * num(p.glowSize) + num(p.coreWidth);
	if (edgeMode(p)) return num(p.wrinkle) * 0.3 + 0.35 * num(p.boltLength) + glow + 4;
	return num(p.boltLength) * (1 + 1.2 * (num(p.jaggedness) / 100)) + glow + 4;
};

export const GENERATOR_LIGHTNING = defineGenerator({
	id: 'lightning',
	label: 'Lightning',
	effectLabel: 'Title Lightning',
	description:
		'Electric arcs shooting from the edges of the title and crawling over them, boiling or crawling.',
	keywords: ['electric', 'arc', 'bolt', 'plasma', 'energy', 'electrify'],
	params: [
		lp.choice('mode', 'Arcs', MODES, ['Mixed', 'Shoot Outward', 'Crawl Along Edge', 'Along Edge'], 'mixed'),
		lp.choice('motion', 'Motion', ['boil', 'crawl'], ['Hold-Frame Boil', 'Continuous Crawl'], 'boil'),
		...boilParams(12),
		lp.number('crawlSpeed', 'Crawl Speed', 1.2, { min: -20, max: 20, softMin: 0, softMax: 6, step: 0.01 }),
		lp.number('count', 'Bolt Count', 12, { min: 1, max: 40, step: 1 }),
		lp.number('arcs', 'Arc Count', 24, { min: 1, max: 60, step: 1 }),
		lp.distance('boltLength', 'Bolt Length', 110, { min: 1, softMax: 400 }),
		lp.percent('jaggedness', 'Jaggedness', 55, { range: { max: 150 } }),
		lp.percent('branches', 'Branching', 60),
		lp.percent('wrinkle', 'Wrinkle', 60, { range: { max: 150 } }),
		lp.distance('coreWidth', 'Core Width', 1.75, { min: 0.1, softMax: 10 }),
		lp.distance('glowSize', 'Glow Size', 9, { softMax: 40 }),
		lp.number('glowStrength', 'Glow Strength', 100, { min: 0, max: 300, step: 1 }, { unit: '%' }),
		lp.color('color', 'Glow Colour', hex('#4fd8ff')),
		lp.number('intensity', 'Intensity', 100, { min: 0, max: 300, step: 1 }, { unit: '%' }),
		lp.distance('capture', 'Capture', 20, { min: 0.5, softMax: 80 }),
		anchorParam(),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	shapeAware: true,
	front: true,
	standIn: 'disc',
	usesBounds: () => true,
	color: { role: 'glow', mode: 'light' },
	defines: (p) => `#define TLG_LIGHTNING ${Math.max(0, MODES.indexOf(String(p.mode)))}\n`,
	presets: [
		{ id: 'bolts', label: 'Lightning Bolts', params: {} },
		{
			id: 'electric',
			label: 'Electric Blue',
			params: {
				mode: 'outward',
				count: 9,
				boltLength: 85,
				jaggedness: 60,
				coreWidth: 1.1,
				glowSize: 6,
				glowStrength: 110,
				color: hex('#5fd8ff'),
				variation: 4,
			},
		},
		{ id: 'electrify', label: 'Electrify', params: { mode: 'edge', motion: 'crawl', variation: 3 } },
		{
			id: 'boil',
			label: 'Red Boil',
			params: { mode: 'edge', boilRate: 8, color: hex('#ff4a6a'), glowSize: 7, variation: 8 },
		},
	],
	reach: reachOf,
	fieldReach: (p) => ({ outside: num(p.capture) + 4, inside: num(p.capture) + 4 }),
	timeDependent: () => true,
	summary: (p) => `${String(p.mode)}, ${boltCount(p)} arcs, ${pct(p.boltLength)}`,
	prepass: (p, c) => [
		c.pass({
			output: 'tlGenA',
			format: 'rgba16f',
			include: [GLSL_UV, GLSL_TLG_SITES, GLSL_TLG_QUAD],
			draw: {
				vertices: SEGMENTS * 6,
				instances: boltCount(p) * PER_BOLT,
				blend: 'max',
				vert: /* glsl */ `
out vec2 v_l;         // px along from the segment's centre, px across
flat out vec4 v_s;    // half length, core half width, intensity, glow px
int tlg_step, tlg_strike;   // the held jag; the strike a bolt is on
float tlg_phase;            // the continuous slide of the noise
float tlg_rs(int b, int k) { return tlg_h3(b, tlg_strike, k); }
// Fractal noise along a bolt: midpoint displacement as a closed form, -1..1 by octave weights; x = 0..1.
float tlg_jag(float x, int b, float o) {
  float sum = 0.0, amp = 1.0, f = 3.0;
  for (int k = 0; k < 5; k++) {
    int ch = b * 31 + k * 7 + tlg_step * 1009 + 200;
    sum += amp * (tlg_noise1(x * f + o + tlg_phase * (1.0 + 0.5 * float(k)), ch) - 0.5) * 2.0;
    amp *= 0.55;
    f *= 2.0;
  }
  return sum;
}
struct TlgBolt { vec2 a, b, n; float gain, len; bool live; };
TlgBolt tlg_bolt(int b) {
  float capture = max(tl_px(u_capture), 1.0);
  float L = tl_px(u_boltLength);
  TlgBolt o;
  vec2 q = tlg_anchor(vec2(tlg_rs(b, 1), tlg_rs(b, 2)));
  TlgSite s = tlg_site(q, true, 0.0, capture);
  o.live = s.gate > 0.01;
  o.gain = (0.7 + 0.3 * tlg_rs(b, 3)) * s.gate;
  o.a = s.px;
  o.n = s.normal;
  o.len = L * (0.55 + 0.45 * tlg_rs(b, 4));
  bool crawl = TLG_LIGHTNING == 2 || (TLG_LIGHTNING == 0 && tlg_rs(b, 5) < 0.45);
  if (crawl) {
    // Arc to another point of the edge roughly a bolt away along it, bulging outward.
    vec2 t = vec2(-s.normal.y, s.normal.x) * (tlg_rs(b, 6) < 0.5 ? -1.0 : 1.0);
    TlgSite e = tlg_site(s.px + t * o.len + s.normal * o.len * 0.2, true, 0.0, capture * 2.0);
    if (e.gate <= 0.01 || length(e.px - s.px) < tl_px(3.0)) o.live = false;
    o.b = e.px;
    o.len = length(o.b - o.a);
    o.n = normalize(s.normal + e.normal + vec2(1.0e-4, 0.0));
  } else {
    float ang = (tlg_rs(b, 7) - 0.5) * 1.3;
    float c0 = cos(ang), s0 = sin(ang);
    vec2 d = vec2(s.normal.x * c0 - s.normal.y * s0, s.normal.x * s0 + s.normal.y * c0);
    o.b = o.a + d * o.len;
  }
  return o;
}
// The bolt at x = 0..1: pinned at its ends, and thrown off the chord by the jag.
vec2 tlg_path(TlgBolt o, int b, float x, float amount, vec2 side, float bulge) {
  float pin = sqrt(max(sin(3.14159265 * x), 0.0));
  float off = amount * tlg_jag(x, b, 0.0) * pin + bulge * sin(3.14159265 * x);
  return mix(o.a, o.b, x) + side * off;
}
void main() {
  tlg_begin();
  float time = u_tlTime;
  float rate = max(u_boilRate, 0.1);
  int b = gl_InstanceID / ${PER_BOLT};
  int path = gl_InstanceID % ${PER_BOLT};
  float gain = 1.0;
  if (u_motion == 0) {
    // Hold-frame boil: the jag re-rolls every held frame; each bolt re-strikes on its own beat.
    float x = floor(time * rate);
    tlg_step = int(x);
    tlg_strike = int(floor(x / 4.0 + tlg_h(b, 30) * 4.0));
    tlg_phase = 0.0;
    gain = 0.75 + 0.25 * tlg_h3(b, tlg_step, 31);
  } else {
    // Continuous crawl: the jag slides along the bolt; a bolt fades out and strikes elsewhere, unseen.
    float x = time * 0.35 + tlg_h(b, 30) * 4.0;
    tlg_step = 0;
    tlg_strike = int(floor(x));
    tlg_phase = time * u_crawlSpeed * 2.0;
    float f = x - floor(x);
    gain = smoothstep(0.0, 0.12, f) * (1.0 - smoothstep(0.82, 1.0, f));
  }
  float core = max(tl_px(u_coreWidth) * 0.5, 0.35);
  float glow = max(tl_px(u_glowSize), 0.0);
  int seg = gl_VertexID / 6;
  float x0 = float(seg) / ${SEGMENTS}.0, x1 = float(seg + 1) / ${SEGMENTS}.0;
  vec2 p0, p1;
  float taper = 1.0, inten = 1.0;
#if TLG_LIGHTNING == 3
  // Along the edge: the path of a seeded line through the shape, each point pulled onto the outline, hovering off it.
  if (path > 0) { fx_cull(); return; }
  float capture = max(tl_px(u_capture), 1.0);
  float L = tl_px(u_boltLength) * (0.5 + 0.5 * tlg_rs(b, 3));
  vec2 q = tlg_anchor(vec2(tlg_rs(b, 1), tlg_rs(b, 2)));
  float dirA = tlg_rs(b, 4) * FX_TAU;
  vec2 along = vec2(cos(dirA), sin(dirA));
  float wr = tl_px(u_wrinkle * 0.12);
  float amt = u_wrinkle * 0.01;
  TlgSite s0 = tlg_site(q + along * L * (x0 - 0.5), true, 0.0, capture);
  TlgSite s1 = tlg_site(q + along * L * (x1 - 0.5), true, 0.0, capture);
  float o0 = wr * (0.5 + 0.5 * tlg_jag(x0, b, 3.0)), o1 = wr * (0.5 + 0.5 * tlg_jag(x1, b, 3.0));
  p0 = s0.px + s0.normal * o0 + vec2(-along.y, along.x) * amt * tl_px(1.5) * tlg_jag(x0 * 4.0, b + 77, 0.0);
  p1 = s1.px + s1.normal * o1 + vec2(-along.y, along.x) * amt * tl_px(1.5) * tlg_jag(x1 * 4.0, b + 77, 0.0);
  // A jump across a counter or between letters is not an arc.
  if (s0.gate <= 0.01 || s1.gate <= 0.01 || length(p1 - p0) > L / ${SEGMENTS}.0 * 5.0 + tl_px(1.0)) { fx_cull(); return; }
  taper = 1.0 - 0.5 * abs(2.0 * x0 - 1.0);
  inten = 0.7 + 0.3 * tlg_rs(b, 5);
#else
  TlgBolt o = tlg_bolt(b);
  if (!o.live) { fx_cull(); return; }
  vec2 chord = o.b - o.a;
  float clen = max(length(chord), 1.0);
  vec2 side = vec2(-chord.y, chord.x) / clen;
  float jag = u_jaggedness * 0.01 * clen * 0.2;
  float bulge = dot(side, o.n) >= 0.0 ? 0.22 * clen : -0.22 * clen;
  bool crawled = TLG_LIGHTNING == 2 || (TLG_LIGHTNING == 0 && tlg_rs(b, 5) < 0.45);
  if (!crawled) bulge = 0.0;
  inten = o.gain;
  if (path == 0) {
    p0 = tlg_path(o, b, x0, jag, side, bulge);
    p1 = tlg_path(o, b, x1, jag, side, bulge);
    taper = 1.0 - 0.5 * x0;
  } else {
    // A branch leaves the bolt part of the way along, at an angle, shorter and dimmer.
    if (tlg_rs(b, 10 + path) > u_branches * 0.01 * 0.7) { fx_cull(); return; }
    float at = 0.2 + 0.6 * tlg_rs(b, 14 + path);
    vec2 root = tlg_path(o, b, at, jag, side, bulge);
    float rot = (tlg_rs(b, 18 + path) < 0.5 ? -1.0 : 1.0) * (0.35 + 0.5 * tlg_rs(b, 22 + path));
    float bl = (0.25 + 0.3 * tlg_rs(b, 26 + path)) * (1.0 - at);
    float cr = cos(rot), sr = sin(rot);
    vec2 tip = root + vec2(chord.x * cr - chord.y * sr, chord.x * sr + chord.y * cr) * bl;
    vec2 bd = tip - root;
    float bll = max(length(bd), 1.0);
    TlgBolt br = o;
    br.a = root;
    br.b = tip;
    vec2 bside = vec2(-bd.y, bd.x) / bll;
    float bj = jag * bl;
    p0 = tlg_path(br, b + path * 53, x0, bj, bside, 0.0);
    p1 = tlg_path(br, b + path * 53, x1, bj, bside, 0.0);
    taper = 0.55 * (1.0 - 0.7 * x0);
    inten *= 0.7;
  }
#endif
  // Thinner than a pixel, a core is drawn a pixel wide at its own energy: the same light at every resolution.
  float hw0 = core * taper;
  float hw = max(hw0, 0.5);
  inten *= hw0 / hw;
  float pad = hw * 1.6 + glow * 3.0 + 1.0;
  vec2 d = p1 - p0;
  float l = max(length(d), 1.0e-3);
  vec2 ux = d / l, uy = vec2(-ux.y, ux.x);
  vec2 q2 = tlg_corner(gl_VertexID);
  vec2 lc = q2 * vec2(0.5 * l + pad, pad);
  v_l = lc;
  v_s = vec4(0.5 * l, hw, inten * gain, glow);
  fx_emit(0.5 * (p0 + p1) + ux * lc.x + uy * lc.y);
}`,
			},
			frag: /* glsl */ `
in vec2 v_l;
flat in vec4 v_s;
void main() {
  // The distance to the capsule of this segment, so joints are round; MAX blending keeps them from doubling.
  float x = max(abs(v_l.x) - v_s.x, 0.0);
  float d = length(vec2(x, v_l.y));
  float w = v_s.y;
  float I = v_s.z;
  float g = max(v_s.w, 1.0e-3);
  // The glow ends inside the quad: an exponential cut at its edge would draw the quad.
  float end = 1.0 - smoothstep(0.6, 1.0, d / (3.0 * g + w * 1.6));
  fragColor = vec4(I * exp(-d * d / (w * w) * 2.2), I * exp(-d / (0.3 * g)) * end, I * exp(-d / g) * end, 1.0);
}`,
		}),
	],
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) {
  vec3 v = texture(u_tlGenA, s.uv).rgb;
  vec3 col = tlg_rgb(u_color);
  vec3 light = v.r * mix(col, vec3(1.0), 0.8) * 1.6 + (v.g * 0.9 + v.b * 0.45) * col * (u_glowStrength * 0.01);
  return tlg_light(light * (u_intensity * 0.01));
}`,
});

// Pattern (TL-061): procedural fills that scroll, optionally on a receding floor plane, after Pachislop's
// generators/pattern.ts and engine/patterns.ts. The marks are analytic signed distances, antialiased over the pixel
// footprint, so a motif reads the same at any resolution. Pachislop's float hashes became integer hashes (TL-035); the
// scroll is a closed form of time. In a look the fill ends at Extent and feathers there.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, lp } from '../contract.ts';
import { GLSL_TLG, hex, num, pct, variationParam } from './shared.ts';

const KINDS = [
	'zebra',
	'tiger',
	'giraffe',
	'leopard',
	'checker',
	'hazard',
	'stripes',
	'dots',
	'sakura',
	'seigaiha',
	'asanoha',
	'shippo',
	'kikko',
	'uroko',
] as const;

const LABELS = [
	'Zebra',
	'Tiger',
	'Giraffe',
	'Leopard',
	'Checker',
	'Hazard',
	'Stripes',
	'Polka Dots',
	'Blossom',
	'Waves',
	'Hemp Leaf',
	'Seven Treasures',
	'Tortoise Shell',
	'Scales',
];

/** Internal units per motif unit, so one motif size reads alike across kinds. */
const SCALE = [0.7, 0.7, 0.45, 0.38, 1, 0.6, 1, 1, 0.32, 0.4, 0.55, 0.65, 0.5, 0.55];

/** Each kind returns (d, d2, w): mark distance, secondary distance (PAT_NONE = none), relief ramp width. */
const MARKS: Record<(typeof KINDS)[number], string> = {
	zebra: /* glsl */ `
// irregular stripes bent by low-frequency noise; their width wanders along the stripe
// and where it falls below zero the stripe tapers to a point and breaks.
float pat_zebraU(vec2 q) { return q.x + 0.95 * pat_gnoise(q * vec2(0.19, 0.13)) + 0.22 * pat_gnoise(q * vec2(0.7, 0.5) + 5.3); }
vec3 pat_zebra(vec2 q, vec2 dqx, vec2 dqy, float px) {
  float u = pat_zebraU(q);
  // Internal units per unit of u, from finite differences along the pixel steps.
  float k = px / max(abs(pat_zebraU(q + dqx) - u) + abs(pat_zebraU(q + dqy) - u), 1e-6);
  float id = floor(u + 0.5);
  float f = u - id;
  float wv = pat_gnoise(vec2(id * 1.73 + 0.31, q.y * 0.5));
  float hw = 0.25 + 0.24 * wv + 0.05 * pat_gnoise(q * 1.7 + 7.1);
  return vec3((abs(f) - min(hw, 0.4)) * k, PAT_NONE, 0.1);
}
`,
	tiger: /* glsl */ `
// a stripe per unit of u, broken along v into strokes that swell off-centre and taper to
// needle tips; some strokes fork into two prongs at one end, some cells stay empty, and short
// dashes sit midway between the stripes. Distances are in u units (stripe spacing 1), scaled to
// internal units by k.
float pat_tigerU(vec2 q) { return q.x * 0.6 + 0.4 * pat_gnoise(q * vec2(0.22, 0.16)) + 0.06 * pat_gnoise(q * 1.1 + 2.0); }
// Half-width profile over t in [0, 1]: 0 at both tips, 1 at the peak, which skew (1 = centred) moves.
float pat_tigerW(float t, float skew) { float s = pow(clamp(t, 0.0, 1.0), skew); return pow(4.0 * s * (1.0 - s), 0.85); }
// Distance to a stroke on f = 0 over v in [0, len] with peak half-width w; h is the stroke's hash.
// fork: 0 none, else the end (+1: v = len, -1: v = 0) that splits into two prongs.
float pat_tigerStroke(float f, float v, float len, float w, float h, float fork) {
  float t = v / len;
  float skew = mix(0.75, 1.35, h);
  float cap = max(-v, v - len);
  float hw = w * pat_tigerW(t, skew);
  if (fork == 0.0) return max(abs(f) - hw, cap);
  float t0 = mix(0.45, 0.65, fract(h * 7.31));
  float tf = fork > 0.0 ? t : 1.0 - t;
  float tau = max(tf - t0, 0.0) / (1.0 - t0); // 0 at the split to 1 at the forked end
  float span = (1.0 - t0) * len;
  // The body narrows to a point half-way along the prongs.
  float body = max(max(abs(f) - hw * (1.0 - smoothstep(0.0, 0.5, tau)), cap), (tau - 0.5) * span);
  float pw = 0.7 * w * pat_tigerW(fork > 0.0 ? t0 : 1.0 - t0, skew);
  float sep = (0.7 * w + 0.08) * pow(tau, 1.3);
  float before = (t0 - tf) * len;
  float l2 = mix(0.55, 1.0, fract(h * 13.7));
  float p1 = max(max(abs(f - sep) - pw * pow(max(1.0 - tau, 0.0), 1.1), before), cap);
  float p2 = max(max(abs(f + 0.85 * sep) - pw * pow(max(1.0 - tau / l2, 0.0), 1.1), before), (tau - l2) * span);
  return min(body, min(p1, p2));
}
vec3 pat_tiger(vec2 q, vec2 dqx, vec2 dqy, float px) {
  float u = pat_tigerU(q);
  float k = px / max(abs(pat_tigerU(q + dqx) - u) + abs(pat_tigerU(q + dqy) - u), 1e-6);
  float v = q.y * 0.6 + 0.25 * pat_gnoise(q * vec2(0.3, 0.2) + 5.1);
  float id0 = floor(u);
  float d = PAT_NONE;
  // The two stripes either side (a stroke reaches at most ~0.55 from its stripe).
  for (int i = 0; i < 2; i++) {
    float id = id0 + float(i);
    float hs = pat_h21(vec2(id, 4.1));
    float period = mix(4.5, 7.5, hs);
    float vs = v + hs * 17.0;
    float j = floor(vs / period);
    vec2 ha = pat_h22(vec2(id, j) + 0.37), hb = pat_h22(vec2(j, id) + 9.2);
    if (ha.x < 0.1) continue;
    float gap = mix(0.3, 1.0, ha.y);
    float fork = hb.x < 0.4 ? (hb.y < 0.5 ? -1.0 : 1.0) : 0.0;
    float w = mix(0.15, 0.28, fract(ha.x * 3.7));
    d = min(d, pat_tigerStroke(u - id - (hb.y - 0.5) * 0.14, vs - j * period - gap * hb.x, period - gap, w, ha.x, fork));
  }
  // Dashes midway between the stripes, in about half of their cells.
  float vd = v + pat_h21(vec2(id0, 8.3)) * 11.0;
  float jd = floor(vd / 1.8);
  vec2 hc = pat_h22(vec2(id0, jd) + 5.9), hd = pat_h22(vec2(jd, id0) + 2.4);
  if (hc.x > 0.5) {
    float len = mix(0.4, 1.0, hc.y);
    d = min(d, pat_tigerStroke(u - id0 - 0.5 - (hd.x - 0.5) * 0.16, vd - jd * 1.8 - (1.8 - len) * hd.y, len, mix(0.05, 0.1, hd.y), hc.x, 0.0));
  }
  return vec3(d * k, PAT_NONE, 0.12);
}
`,
	giraffe: /* glsl */ `
// rounded Voronoi patches (the marks) separated by gaps of the base colour.
vec3 pat_giraffe(vec2 q, float seed) {
  q = pat_warp(q, 1.6, 0.07);
  vec2 n = floor(q), f = fract(q);
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + 0.5 + 0.38 * sin(6.2831853 * pat_h22(n + g) + seed) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float e = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + 0.5 + 0.38 * sin(6.2831853 * pat_h22(n + g) + seed) - f;
    vec2 dr = r - mr;
    if (dot(dr, dr) > 1e-5) e = pat_smin(e, dot(0.5 * (mr + r), normalize(dr)), 0.14);
  }
  return vec3(0.055 - e, PAT_NONE, 0.1);
}
`,
	leopard: /* glsl */ `
// broken rosette rings (3–5 arcs) with color2 centres, plus some solid spots.
vec3 pat_leopard(vec2 q) {
  q = pat_warp(q, 1.3, 0.05);
  vec2 n = floor(q), f = fract(q);
  float d = PAT_NONE, d2 = PAT_NONE;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 c = n + g;
    vec2 h = pat_h22(c);
    float h3 = pat_h21(c + 4.7), h4 = pat_h21(c + 8.3);
    vec2 r = f - (g + 0.28 + 0.44 * h);
    float ang = atan(r.y, r.x);
    float rr = length(r) * (1.0 + 0.14 * sin(2.0 * ang + 6.2831853 * h4) + 0.05 * sin(3.0 * ang + 9.0 * h3));
    if (h3 > 0.84) {
      d = min(d, rr - 0.08 - 0.05 * h4);
    } else {
      float R = 0.24 + 0.05 * h3;
      float lobes = 3.0 + floor(h4 * 2.999);
      float s = smoothstep(0.1, 0.42, 0.5 + 0.5 * cos(lobes * ang + 6.2831853 * h3));
      float th = 0.075 * s - 0.018 + 0.012 * sin(5.0 * ang + 5.0 * h4) + 0.012 * pat_gnoise(r * 7.0 + c);
      float dr = abs(rr - R) - th;
      d = min(d, dr);
      d2 = min(d2, max(rr - R, -dr));
    }
  }
  return vec3(d, d2, 0.05);
}
`,
	checker: /* glsl */ `
// Racing chequer: marks on one parity, color2 on the other.
vec3 pat_checker(vec2 q) {
  vec2 cell = floor(q), fr = q - cell;
  float e = min(min(fr.x, 1.0 - fr.x), min(fr.y, 1.0 - fr.y));
  float d = mod(cell.x + cell.y, 2.0) < 0.5 ? -e : e;
  return vec3(d, -d, 0.08);
}
`,
	hazard: /* glsl */ `
// DANGER tape: 45° stripes alternating mark / color2.
vec3 pat_hazard(vec2 q) {
  float u = (q.x - q.y) * 0.7071068;
  float d = abs(fract(u) - 0.25) - 0.25;
  return vec3(d, -d, 0.06);
}
`,
	stripes: /* glsl */ `
vec3 pat_stripes(vec2 q) {
  return vec3(abs(fract(q.x) - 0.5) - 0.25, PAT_NONE, 0.08);
}
`,
	dots: /* glsl */ `
// Polka dots on two interleaved square grids.
vec3 pat_dots(vec2 q) {
  float d = min(length(fract(q) - 0.5), length(fract(q + 0.5) - 0.5)) - 0.2;
  return vec3(d, PAT_NONE, 0.08);
}
`,
	sakura: /* glsl */ `
// scattered five-petal blossoms with notched petal tips and color2 centres.
vec3 pat_sakura(vec2 q) {
  vec2 n = floor(q), f = fract(q);
  float d = PAT_NONE, d2 = PAT_NONE;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 c = n + g;
    if (pat_h21(c + 2.9) >= 0.12) {
      vec2 h = pat_h22(c);
      float R = 0.27 + 0.1 * pat_h21(c + 6.1);
      vec2 r = f - (g + 0.3 + 0.4 * h);
      float rl = length(r);
      float ang = atan(r.y, r.x) + 6.2831853 * pat_h21(c + 1.3);
      float a = mod(ang, 1.2566371) - 0.6283185; // one petal, about ±36°
      float petal = R * (0.42 + 0.58 * pow(max(cos(a * 2.5), 0.0), 0.6));
      petal -= R * 0.2 * max(0.0, 1.0 - abs(a) / 0.14); // V notch at the tip
      d = min(d, (rl - petal) * 0.8);
      d2 = min(d2, rl - R * 0.17);
    }
  }
  return vec3(d, d2, 0.05);
}
`,
	seigaiha: /* glsl */ `
// rows of concentric fans; lower rows overlap the ones above.
vec3 pat_seigaiha(vec2 q, float px) {
  const float R = 0.5, rowH = 0.25, hw = 0.022, sp = R / 4.0;
  float j0 = floor(q.y / rowH);
  float l = R;
  // Back to front (highest row first); the lowest row containing q wins.
  for (int k = 2; k >= -2; k--) {
    float j = j0 + float(k);
    float off = mod(j, 2.0) * 0.5;
    vec2 c = vec2(floor(q.x - off + 0.5) + off, j * rowH);
    float lk = length(q - c);
    if (lk < R + hw + px) l = lk;
  }
  float ring = clamp(floor(l / sp + 0.5), 1.0, 4.0);
  return vec3(abs(l - ring * sp) - hw, PAT_NONE, hw);
}
`,
	asanoha: /* glsl */ `
// equilateral triangle lattice plus spokes from each triangle's centroid to its corners.
vec3 pat_asanoha(vec2 q) {
  const float H = 0.8660254, hw = 0.022;
  vec2 st = vec2(q.x - 0.5 * q.y / H, q.y / H);
  vec2 cell = floor(st), f = st - cell;
  vec2 A = cell, B, C;
  if (f.x + f.y < 1.0) { B = cell + vec2(1.0, 0.0); C = cell + vec2(0.0, 1.0); }
  else { A = cell + vec2(1.0, 0.0); B = cell + vec2(1.0, 1.0); C = cell + vec2(0.0, 1.0); }
  vec2 a = vec2(A.x + 0.5 * A.y, A.y * H), b = vec2(B.x + 0.5 * B.y, B.y * H), c = vec2(C.x + 0.5 * C.y, C.y * H);
  vec2 m = (a + b + c) / 3.0;
  float d = min(min(pat_seg(q, a, b), pat_seg(q, b, c)), pat_seg(q, c, a));
  d = min(d, min(min(pat_seg(q, m, a), pat_seg(q, m, b)), pat_seg(q, m, c)));
  return vec3(d - hw, PAT_NONE, hw);
}
`,
	shippo: /* glsl */ `
// circles on a square grid, each overlapped a quarter by its four neighbours.
vec3 pat_shippo(vec2 q) {
  const float r = 0.7071068, hw = 0.025;
  vec2 n = floor(q);
  float d = PAT_NONE;
  for (int j = 0; j <= 1; j++) for (int i = 0; i <= 1; i++) d = min(d, abs(length(q - n - vec2(float(i), float(j))) - r));
  return vec3(d - hw, PAT_NONE, hw);
}
`,
	kikko: /* glsl */ `
// flat-top hexagon lattice with a double outline.
vec3 pat_kikko(vec2 q) {
  const float hw = 0.02;
  vec2 s = vec2(1.0, 1.7320508), h = s * 0.5;
  vec2 p = q.yx;
  vec2 a = mod(p, s) - h, b = mod(p - h, s) - h;
  vec2 g = abs(dot(a, a) < dot(b, b) ? a : b);
  float hd = max(dot(g, vec2(0.5, 0.8660254)), g.x); // 0.5 on the cell edge
  float d = min(abs(hd - 0.5) - hw, abs(hd - 0.41) - hw * 0.75);
  return vec3(d, PAT_NONE, hw);
}
`,
	uroko: /* glsl */ `
// upward triangles of the mark colour tiling with downward triangles of the base.
vec3 pat_uroko(vec2 q) {
  const float H = 0.8660254;
  vec2 st = vec2(q.x - 0.5 * q.y / H, q.y / H);
  vec2 f = fract(st);
  float s = f.x + f.y;
  float d = s < 1.0 ? -min(min(f.x, f.y), 1.0 - s) * H : min(min(1.0 - f.x, 1.0 - f.y), s - 1.0) * H;
  return vec3(d, PAT_NONE, 0.07);
}
`,
};

/** The call of each kind. */
const CALLS: Record<(typeof KINDS)[number], string> = {
	zebra: 'pat_zebra(q, dqx, dqy, px)',
	tiger: 'pat_tiger(q, dqx, dqy, px)',
	giraffe: 'pat_giraffe(q, 0.0)',
	leopard: 'pat_leopard(q)',
	checker: 'pat_checker(q)',
	hazard: 'pat_hazard(q)',
	stripes: 'pat_stripes(q)',
	dots: 'pat_dots(q)',
	sakura: 'pat_sakura(q)',
	seigaiha: 'pat_seigaiha(q, px)',
	asanoha: 'pat_asanoha(q)',
	shippo: 'pat_shippo(q)',
	kikko: 'pat_kikko(q)',
	uroko: 'pat_uroko(q)',
};

const kindOf = (v: unknown) => Math.max(0, KINDS.indexOf(v as (typeof KINDS)[number]));

const COMMON = /* glsl */ `
// Hashes of pattern cells: integer hashes of the cell at 1/16 steps (offsets like c + 4.7 stay distinct).
float pat_h21(vec2 p) { return fx_hash2s(ivec2(floor(p * 16.0)), tlg_s); }
vec2 pat_h22(vec2 p) { return fx_hash22s(ivec2(floor(p * 16.0)), tlg_s); }
// Gradient noise, roughly -1..1.
float pat_gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(pat_h22(i) * 2.0 - 1.0, f);
  float b = dot(pat_h22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(pat_h22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(pat_h22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return 1.6 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec2 pat_warp(vec2 q, float freq, float amt) {
  return q + amt * vec2(pat_gnoise(q * freq + 3.7), pat_gnoise(q * freq + 11.3));
}
float pat_smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float pat_seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
const float PAT_NONE = 1e3;

// Each kind returns (d, d2, w): mark distance, secondary distance (PAT_NONE = no colour 2),
// relief ramp width — all in the kind's internal units.
`;

export const GENERATOR_PATTERN = defineGenerator({
	id: 'pattern',
	label: 'Pattern',
	effectLabel: 'Pattern Fill',
	description:
		'Animal prints, racing and hazard fills, and traditional patterns, scrolling, flat or on a floor plane.',
	keywords: ['zebra', 'leopard', 'checker', 'hazard', 'waves', 'floor', 'scroll', 'texture'],
	params: [
		lp.choice('kind', 'Pattern', [...KINDS], LABELS, 'zebra'),
		lp.color('color', 'Colour', hex('#121212')),
		lp.color('color2', 'Colour 2', hex('#ffffff')),
		lp.color('background', 'Background', hex('#f2efe8')),
		lp.percent('bgOpacity', 'Background Opacity', 100),
		lp.distance('motif', 'Motif Size', 70, { min: 2, softMax: 400 }),
		lp.angle('rotation', 'Rotation', 0),
		lp.number('tilt', 'Floor Tilt', 0, { min: 0, max: 80, step: 0.1 }, { unit: 'deg' }),
		lp.number('scrollSpeed', 'Scroll Speed', 0.15, { min: -20, max: 20, softMin: 0, softMax: 2, step: 0.01 }),
		lp.angle('scrollAngle', 'Scroll Angle', 0),
		lp.distance('extent', 'Extent', 120, { min: 1, softMax: 600 }),
		lp.distance('feather', 'Feather', 40, { softMax: 200 }),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	defines: (p) => `#define TLG_PATTERN ${kindOf(p.kind)}\n`,
	color: { role: 'accent2', mode: 'luma' },
	presets: [
		{ id: 'zebra', label: 'Zebra', params: {} },
		{
			id: 'checker',
			label: 'Racing Checker',
			params: { kind: 'checker', color: hex('#111111'), color2: hex('#f5f5f5'), motif: 40, scrollSpeed: 0.8 },
		},
		{
			id: 'hazard',
			label: 'Hazard Tape',
			params: { kind: 'hazard', color: hex('#141414'), color2: hex('#ffd200'), motif: 60, scrollSpeed: 0.5 },
		},
		{
			id: 'waves',
			label: 'Indigo Waves',
			params: {
				kind: 'seigaiha',
				color: hex('#e9c66b'),
				background: hex('#0f2350'),
				motif: 70,
				scrollSpeed: 0.1,
				scrollAngle: 90,
			},
		},
		{
			id: 'floor',
			label: 'Floor Grid',
			params: {
				kind: 'checker',
				color: hex('#1a1040'),
				color2: hex('#ff3ea5'),
				motif: 50,
				tilt: 72,
				scrollSpeed: 1,
				scrollAngle: 90,
			},
		},
	],
	reach: (p) => num(p.extent),
	fieldReach: () => ({ outside: 1 }),
	timeDependent: (p) => num(p.scrollSpeed) !== 0,
	summary: (p) => `${String(p.kind)}, ${pct(p.motif)}`,
	glsl: `${COMMON}
${KINDS.map((k, i) => `#if TLG_PATTERN == ${i}\n${MARKS[k]}\n#endif`).join('\n')}
vec4 tlg_pattern(vec2 p, vec2 dpdx, vec2 dpdy) {
  float S = ${`float[${SCALE.length}](${SCALE.map((v) => v.toFixed(2)).join(', ')})`}[TLG_PATTERN];
  vec2 q = p * S + 256.0;
  vec2 dqx = dpdx * S, dqy = dpdy * S;
  float px = max(length(abs(dqx) + abs(dqy)) * 0.7071068, 1.0e-6);
  vec3 r;
${KINDS.map((k, i) => `#if TLG_PATTERN == ${i}\n  r = ${CALLS[k]};\n#endif`).join('\n')}
  return vec4(clamp(0.5 - r.x / px, 0.0, 1.0), clamp(0.5 - r.y / px, 0.0, 1.0), 0.0, 0.0);
}
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  vec2 lp = s.px - (u_box.xy + u_box.zw * 0.5);
  lp.y = -lp.y;
  float focal = tl_px(540.0);
  float t = radians(clamp(u_tilt, 0.0, 80.0));
  float sinT = sin(t), cosT = cos(t);
  // A floor tilted back about the layer's x axis, seen from in front of its centre; the horizon is where den reaches 0.
  float den = focal * cosT - lp.y * sinT;
  float v = lp.y * focal / max(den, 1.0e-3 * focal);
  vec2 plane = vec2(lp.x * (focal + v * sinT) / focal, v);
  float a = radians(u_rotation);
  float c = cos(a), sn = sin(a);
  vec2 p = vec2(c * plane.x - sn * plane.y, sn * plane.x + c * plane.y) / max(tl_px(u_motif), 1.0);
  p += fx_dir(u_scrollAngle) * vec2(-1.0, 1.0) * u_scrollSpeed * u_tlTime;
  vec2 dx = dFdx(p), dy = dFdy(p);
  vec4 pat = tlg_pattern(p, dx, dy);
  // Past about 4 px per motif the marks only shimmer: they fade toward the horizon, the same at every resolution.
  float k = length(abs(dx) + abs(dy));
  float fade = den > 0.0 ? 1.0 - smoothstep(0.25, 0.7, k) : 0.0;
  float bgA = u_bgOpacity * 0.01;
  vec4 col = vec4(tlg_rgb(u_background) * bgA, bgA);
  col = mix(col, vec4(tlg_rgb(u_color), 1.0), pat.x);
  col = mix(col, vec4(tlg_rgb(u_color2), 1.0), pat.y);
#ifndef TLG_STANDALONE
  vec2 e = min(s.px, u_canvasSize - s.px);
  fade *= smoothstep(0.0, max(tl_px(u_feather), 1.0), min(e.x, e.y));
#endif
  return col * fade;
}`,
});

// Magic Circle (TL-061): up to six concentric rows drawn as antialiased distance fields, each spinning at its own rate,
// optionally laid on a floor, after Pachislop's rings/magicCircle.ts. Pachislop draws text rows from a font atlas on a
// canvas; a plan is pure, so rows of glyphs here are procedural strokes (runes, trigrams, segment digits): resolution
// independent, no font, no texture. Kanji sets were not ported: `docs/wp-notes/title-looks.md` "Generators".
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp, type TitleParamSpec } from '../contract.ts';
import { GLSL_TLG, hex, num, pct, variationParam } from './shared.ts';

const ROW_TYPES = [
	'ring',
	'dashed',
	'ticks',
	'glyphs',
	'polygon',
	'star2',
	'star3',
	'chevrons',
	'arcs',
	'hex',
];
const ROW_LABELS = [
	'Ring',
	'Dashed Ring',
	'Ticks',
	'Glyphs',
	'Polygon',
	'Star n/2',
	'Star n/3',
	'Chevrons',
	'Arcs',
	'Hex Grid',
];
const MAX_ROWS = 6;

type Row = { type: string; radius: number; size: number; count: number; angle?: number; spin?: number };

/** The default stack (Pachislop's gold circle), sizes halved into percent of a 200 px unit. */
const ROWS: Row[] = [
	{ type: 'ring', radius: 100, size: 3, count: 1 },
	{ type: 'glyphs', radius: 91.5, size: 15, count: 30, spin: -12 },
	{ type: 'ring', radius: 83, size: 1.5, count: 1 },
	{ type: 'star2', radius: 83, size: 2, count: 6, spin: 18 },
	{ type: 'ring', radius: 41.5, size: 1.5, count: 1 },
	{ type: 'dashed', radius: 30, size: 2.5, count: 24, spin: -30 },
];

function rowParams(i: number): TitleParamSpec[] {
	const d = ROWS[i]!;
	const n = i + 1;
	const group = `Row ${n}`;
	return [
		lp.choice(`row${n}Type`, 'Type', ROW_TYPES, ROW_LABELS, d.type, { group }),
		lp.number(`row${n}Radius`, 'Radius', d.radius, { min: 0, max: 150, step: 0.1 }, { unit: '%', group }),
		lp.distance(`row${n}Size`, 'Size', d.size, { min: 0.25, softMax: 100, group }),
		lp.number(`row${n}Count`, 'Count', d.count, { min: 1, max: 360, softMax: 120, step: 1 }, { group }),
		lp.angle(`row${n}Angle`, 'Angle', 0, { group }),
		lp.number(
			`row${n}Spin`,
			'Spin',
			d.spin ?? 0,
			{ min: -720, max: 720, softMin: -90, softMax: 90, step: 0.1 },
			{ unit: 'deg', group },
		),
	];
}

/** Preset params: a row stack plus the rest. */
function stack(rows: Row[], rest: LayerParams): LayerParams {
	const out: LayerParams = { rows: rows.length, ...rest };
	rows.forEach((r, i) => {
		const k = `row${i + 1}`;
		out[`${k}Type`] = r.type;
		out[`${k}Radius`] = r.radius;
		out[`${k}Size`] = r.size;
		out[`${k}Count`] = r.count;
		out[`${k}Angle`] = r.angle ?? 0;
		out[`${k}Spin`] = r.spin ?? 0;
	});
	return out;
}

function outer(p: LayerParams): number {
	const R = Math.max(1, num(p.radius));
	const rows = Math.min(MAX_ROWS, Math.max(1, Math.round(num(p.rows, MAX_ROWS))));
	let E = R;
	for (let i = 1; i <= rows; i++)
		E = Math.max(E, (R * num(p[`row${i}Radius`])) / 100 + num(p[`row${i}Size`]));
	return E + 2;
}

const uniformRows = Array.from({ length: MAX_ROWS }, (_, i) => {
	const k = `u_row${i + 1}`;
	return /* glsl */ `
  tlg_A[${i}] = vec4(float(${k}Type), R * ${k}Radius * 0.01, tl_px(${k}Size), ${k}Count);
  tlg_ang[${i}] = radians(${k}Angle + ${k}Spin * u_tlTime);`;
}).join('');

export const GENERATOR_MAGIC_CIRCLE = defineGenerator({
	id: 'magicCircle',
	label: 'Magic Circle',
	description:
		'Rings, dashes, ticks, glyphs, stars and hex bands, each row turning at its own speed, flat or on a floor.',
	keywords: ['hud', 'ring', 'rune', 'hologram', 'radar', 'circle', 'spell'],
	params: [
		lp.point('center', 'Centre', [0.5, 0.5]),
		lp.distance('radius', 'Radius', 160, { min: 1, softMax: 600 }),
		lp.angle('rotation', 'Rotation', 0),
		lp.number(
			'spin',
			'Spin',
			10,
			{ min: -720, max: 720, softMin: -90, softMax: 90, step: 0.1 },
			{ unit: 'deg' },
		),
		lp.number('tilt', 'Tilt', 0, { min: 0, max: 80, step: 0.1 }, { unit: 'deg' }),
		lp.color('colorIn', 'Centre Colour', hex('#fff6d0')),
		lp.color('colorOut', 'Edge Colour', hex('#f0b030')),
		lp.percent('fill', 'Inner Fill', 6),
		lp.choice(
			'glyphs',
			'Glyphs',
			['runes', 'trigrams', 'digits'],
			['Runes', 'Trigrams', 'Segment Digits'],
			'runes',
		),
		lp.number('rows', 'Rows', MAX_ROWS, { min: 1, max: MAX_ROWS, step: 1 }),
		...Array.from({ length: MAX_ROWS }, (_, i) => rowParams(i)).flat(),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	color: { role: 'glow', mode: 'light' },
	presets: [
		{ id: 'gold', label: 'Gold Circle', params: {} },
		{
			id: 'hud',
			label: 'Target HUD',
			params: stack(
				[
					{ type: 'ring', radius: 100, size: 1, count: 1 },
					{ type: 'ticks', radius: 96, size: 8, count: 72, spin: 6 },
					{ type: 'arcs', radius: 82, size: 4, count: 6, spin: -24 },
					{ type: 'glyphs', radius: 70, size: 8, count: 42, spin: 14 },
					{ type: 'chevrons', radius: 50, size: 17, count: 4, angle: 45, spin: -40 },
					{ type: 'dashed', radius: 22, size: 1.5, count: 12, spin: 60 },
				],
				{
					radius: 150,
					colorIn: hex('#d8ffff'),
					colorOut: hex('#29c4ff'),
					fill: 0,
					glyphs: 'digits',
					spin: 0,
				},
			),
		},
		{
			id: 'hologram',
			label: 'Hologram Base',
			params: stack(
				[
					{ type: 'ring', radius: 100, size: 4, count: 1 },
					{ type: 'hex', radius: 97, size: 55, count: 48 },
					{ type: 'ticks', radius: 68, size: 6, count: 120, spin: 10 },
					{ type: 'arcs', radius: 58, size: 3, count: 5, spin: -20 },
					{ type: 'ring', radius: 50, size: 1.5, count: 1 },
					{ type: 'dashed', radius: 34, size: 4, count: 16, spin: 30 },
				],
				{
					radius: 180,
					colorIn: hex('#e6ffff'),
					colorOut: hex('#00b8ff'),
					fill: 18,
					glyphs: 'digits',
					tilt: 68,
					spin: 4,
				},
			),
		},
		{
			id: 'bagua',
			label: 'Trigram Wheel',
			params: stack(
				[
					{ type: 'ring', radius: 100, size: 2.5, count: 1 },
					{ type: 'polygon', radius: 96, size: 1.5, count: 8, angle: 22.5 },
					{ type: 'glyphs', radius: 82, size: 23, count: 8, spin: 8 },
					{ type: 'polygon', radius: 66, size: 1, count: 8, angle: 22.5 },
					{ type: 'ring', radius: 50, size: 1.5, count: 1 },
					{ type: 'star2', radius: 48, size: 1, count: 8, spin: -14 },
				],
				{ colorIn: hex('#fff0c0'), colorOut: hex('#ff6a1a'), fill: 0, glyphs: 'trigrams', spin: 0 },
			),
		},
	],
	reach: (p) => outer(p) * 1.5 + 2,
	fieldReach: () => ({ outside: 1 }),
	timeDependent: (p) => {
		if (num(p.spin) !== 0) return true;
		for (let i = 1; i <= MAX_ROWS; i++) if (num(p[`row${i}Spin`]) !== 0) return true;
		return false;
	},
	summary: (p) => `${Math.round(num(p.rows))} rows, ${pct(p.radius)}`,
	glsl: /* glsl */ `
const float TLG_PI = 3.14159265, TLG_TAU = 6.28318531;
vec2 tlg_Jx, tlg_Jy;
vec4 tlg_A[6];
float tlg_ang[6];
float tlg_aaAlong(vec2 g) { return max(length(vec2(dot(tlg_Jx, g), dot(tlg_Jy, g))), 1.0e-4); }
float tlg_cover(float d, float aa) { return clamp(0.5 - d / aa, 0.0, 1.0); }
vec2 tlg_closest(vec2 p, vec2 a, vec2 b) {
  vec2 ba = b - a;
  return a + ba * clamp(dot(p - a, ba) / max(dot(ba, ba), 1.0e-6), 0.0, 1.0);
}
vec4 tlg_hexCell(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy) : vec4(h.zw, hc.zw + 0.5);
}
// A glyph in a cell, p in -0.5..0.5 (y up, away from the centre), aa in cell units. Procedural, from the slot number.
float tlg_seg(vec2 p, vec2 a, vec2 b) { return length(p - tlg_closest(p, a, b)); }
float tlg_glyph(vec2 p, int g, float aa) {
  float d = 1.0e3;
  if (u_glyphs == 1) {
    // Trigrams: three bars, each whole or broken, from the bits of the slot.
    int bits = g % 8;
    for (int i = 0; i < 3; i++) {
      float y = 0.28 - float(i) * 0.28;
      bool whole = ((bits >> i) & 1) == 1;
      if (whole) d = min(d, tlg_seg(p, vec2(-0.34, y), vec2(0.34, y)));
      else d = min(d, min(tlg_seg(p, vec2(-0.34, y), vec2(-0.08, y)), tlg_seg(p, vec2(0.08, y), vec2(0.34, y))));
    }
    return tlg_cover(d - 0.06, aa);
  }
  if (u_glyphs == 2) {
    // Segment digits: seven strokes, lit from a table of the sixteen hex digits.
    int table[16] = int[16](0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71);
    int bits = table[int(tlg_h(g, 41) * 15.999)];
    const float x = 0.2, y = 0.34;
    if ((bits & 1) != 0) d = min(d, tlg_seg(p, vec2(-x, y), vec2(x, y)));
    if ((bits & 2) != 0) d = min(d, tlg_seg(p, vec2(x, y), vec2(x, 0.0)));
    if ((bits & 4) != 0) d = min(d, tlg_seg(p, vec2(x, 0.0), vec2(x, -y)));
    if ((bits & 8) != 0) d = min(d, tlg_seg(p, vec2(-x, -y), vec2(x, -y)));
    if ((bits & 16) != 0) d = min(d, tlg_seg(p, vec2(-x, 0.0), vec2(-x, -y)));
    if ((bits & 32) != 0) d = min(d, tlg_seg(p, vec2(-x, y), vec2(-x, 0.0)));
    if ((bits & 64) != 0) d = min(d, tlg_seg(p, vec2(-x, 0.0), vec2(x, 0.0)));
    return tlg_cover(d - 0.05, aa);
  }
  // Runes: a stem and strokes between points of a 3 × 4 lattice, the same for the same slot and seed.
  d = tlg_seg(p, vec2(0.0, -0.38), vec2(0.0, 0.38));
  for (int i = 0; i < 3; i++) {
    int a = int(tlg_h3(g, i, 42) * 11.999), b = int(tlg_h3(g, i, 43) * 11.999);
    vec2 pa = vec2(float(a % 3) - 1.0, float(a / 3) - 1.5) * vec2(0.26, 0.25);
    vec2 pb = vec2(float(b % 3) - 1.0, float(b / 3) - 1.5) * vec2(0.26, 0.25);
    if (a != b) d = min(d, tlg_seg(p, pa, pb));
  }
  return tlg_cover(d - 0.05, aa);
}
// Coverage of row i at plane point pl (radius r, radial unit er; aaR and aaT across and along the rings).
float tlg_row(int i, vec2 pl, float r, vec2 er, float aaR, float aaT) {
  vec4 A = tlg_A[i];
  int type = int(A.x + 0.5);
  float R = A.y, sz = A.z, n = max(floor(A.w + 0.5), 1.0);
  float a0 = 0.5 * TLG_PI + tlg_ang[i];
  float th = a0 - atan(pl.y, pl.x);
  float phi = th / TLG_TAU * n;
  float slot = TLG_TAU / n;
  if (type == 0) return tlg_cover(abs(r - R) - 0.5 * sz, aaR);
  if (type == 1) {
    float pc = phi - floor(phi + 0.5);
    return tlg_cover(abs(r - R) - 0.5 * sz, aaR) * tlg_cover((abs(pc) - 0.3) * slot * r, aaT);
  }
  if (type == 2) {
    // Ticks hang inward. Long majors every 5th, 4th or 3rd tick, whichever divides the count.
    float k = floor(phi + 0.5);
    float every = mod(n, 5.0) < 0.5 ? 5.0 : mod(n, 4.0) < 0.5 ? 4.0 : mod(n, 3.0) < 0.5 ? 3.0 : 0.0;
    float L = n >= 20.0 && every > 0.0 && mod(mod(k, n), every) < 0.5 ? 1.7 * sz : sz;
    float w = max(0.12 * sz, 1.0);
    return tlg_cover(abs(r - (R - 0.5 * L)) - 0.5 * L, aaR) * tlg_cover(abs(phi - k) * slot * r - 0.5 * w, aaT);
  }
  if (type == 3 || type == 7) {
    float k = floor(phi + 0.5);
    float a = a0 - k * slot;
    vec2 ur = vec2(cos(a), sin(a)), ux = vec2(ur.y, -ur.x);
    vec2 lc = vec2(dot(pl, ux), dot(pl, ur) - R);
    if (type == 3) {
      vec2 uv = lc / sz;
      if (any(greaterThan(abs(uv), vec2(0.5)))) return 0.0;
      return tlg_glyph(uv, int(mod(k, n)) + i * 97, 0.5 * (aaR + aaT) / sz);
    }
    vec2 pa = vec2(-0.5 * sz, 0.25 * sz), pb = vec2(0.0, -0.25 * sz), pc = vec2(0.5 * sz, 0.25 * sz);
    vec2 c1 = tlg_closest(lc, pa, pb), c2 = tlg_closest(lc, pb, pc);
    vec2 dv = lc - (length(lc - c1) < length(lc - c2) ? c1 : c2);
    float d = length(dv);
    vec2 g = d > 1.0e-5 ? dv / d : vec2(0.0, 1.0);
    return tlg_cover(d - 0.11 * sz, tlg_aaAlong(g.x * ux + g.y * ur));
  }
  if (type >= 4 && type <= 6) {
    // Polygon {n} or star {n/2}, {n/3}: chords between vertices on the row circle, the first at the top.
    int nn = int(clamp(n, 2.0, 32.0) + 0.5);
    float stepA = float(type - 3) * TLG_TAU / float(nn);
    float best = 1.0e9;
    vec2 bv = er;
    for (int j = 0; j < nn; j++) {
      float va = a0 + float(j) * TLG_TAU / float(nn);
      vec2 dv = pl - tlg_closest(pl, R * vec2(cos(va), sin(va)), R * vec2(cos(va + stepA), sin(va + stepA)));
      float d = length(dv);
      if (d < best) { best = d; bv = dv; }
    }
    return tlg_cover(best - 0.5 * sz, tlg_aaAlong(best > 1.0e-5 ? bv / best : er));
  }
  if (type == 8) {
    // Random arcs, one chance per slot: start, length and thickness from the seed.
    float k = floor(phi), f = phi - k;
    int id = int(mod(k, n)) + i * 131;
    if (tlg_h(id, 51) > 0.8) return 0.0;
    float st = 0.04 + 0.3 * tlg_h(id, 52);
    float len = 0.2 + (0.72 - st) * tlg_h(id, 53);
    float thick = sz * (0.35 + 0.65 * tlg_h(id, 54));
    return tlg_cover(abs(r - R) - 0.5 * thick, aaR) * tlg_cover(max(st - f, f - st - len) * slot * r, aaT);
  }
  // Hex grid filling the band [R − size, R], n cells around, fading inward.
  float cs = TLG_TAU * R / n;
  vec2 hp = abs(tlg_hexCell(pl / cs).xy);
  float edge = max(dot(hp, vec2(0.5, 0.8660254)), hp.x);
  float band = tlg_cover(r - R, aaR) * smoothstep(R - sz, R - 0.55 * sz, r);
  return band * tlg_cover((0.5 - edge) * cs - 0.5 * max(1.0, 0.08 * cs), 0.5 * (aaR + aaT));
}
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  float R = max(tl_px(u_radius), 1.0);
  float E = R * 1.05 + tl_px(4.0);
  float focal = 3.0 * E;
  float tilt = radians(clamp(u_tilt, 0.0, 80.0));
  vec2 lp = s.px - fx_uvOfLayerNorm(u_center) * u_canvasSize;
  // Up on screen is -y here; the floor recedes upward.
  lp.y = -lp.y;
  float sinT = sin(tilt), cosT = cos(tilt);
  float den = focal * cosT - lp.y * sinT;
  float v = lp.y * focal / max(den, 1.0e-3 * focal);
  vec2 pl = vec2(lp.x * (focal + v * sinT) / focal, v);
  float spin = radians(u_rotation + u_spin * u_tlTime);
  float cs = cos(spin), sn = sin(spin);
  pl = vec2(cs * pl.x + sn * pl.y, -sn * pl.x + cs * pl.y);
  tlg_Jx = dFdx(pl);
  tlg_Jy = dFdy(pl);
  float r = length(pl);
  vec2 er = r > 1.0e-4 ? pl / r : vec2(1.0, 0.0);
  float aaR = tlg_aaAlong(er), aaT = tlg_aaAlong(vec2(-er.y, er.x));
  ${uniformRows}
  int rows = int(clamp(floor(u_rows + 0.5), 1.0, ${MAX_ROWS}.0));
  float cov = 0.0, fillR = 0.0;
  for (int i = 0; i < rows; i++) {
    cov = max(cov, tlg_row(i, pl, r, er, aaR, aaT));
    fillR = max(fillR, tlg_A[i].y);
  }
  float fr = r / max(fillR, 1.0);
  cov = max(cov, (u_fill * 0.01) * tlg_cover(r - fillR, aaR) * (0.35 + 0.65 * min(fr * fr, 1.0)));
  vec3 c = mix(tlg_rgb(u_colorIn), tlg_rgb(u_colorOut), clamp(r / R, 0.0, 1.0));
  float a = cov * (den > 1.0e-3 * focal ? 1.0 : 0.0);
  return vec4(c * a, a);
}`,
});

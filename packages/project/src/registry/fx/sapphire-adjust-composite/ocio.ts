// Built-in colour-space conversions of S_OCIOTransform (fx family sapphire-adjust-composite). There is no OpenColorIO
// library here, so the effect offers a fixed set of common spaces, each = a transfer curve + RGB primaries, converted
// through ACES2065-1 (linear AP0, the reference space of the OCIO ACES configs): decode the curve → 3×3 matrix
// (source primaries → AP0 → destination primaries, Bradford-adapted D65 ↔ ACES white as in OCIO's studio config)
// → encode the curve. Custom OCIO configs, looks and display/view transforms (RRT/ODT tone mapping) are not supported.
// Curves and constants are the published ones:
//   sRGB IEC 61966-2-1; BT.709 OETF; BT.1886 (Lb = 0, Lw = 1 → V^2.4); BT.2020 OETF (α = 1.09929682680944,
//   β = 0.018053968510807); ACEScct S-2016-001; ARRI LogC3 EI800 (ARRI white paper, OCIO's unrounded constants);
//   Sony S-Log3 (S-Gamut3/S-Log3 technical summary); Panasonic V-Log (V-Log/V-Gamut reference manual).
// Matrices (row-major, M · [r g b]ᵀ) to AP0: from the primaries + Bradford CAT, equal to OCIO studio-config-v2.2.0.
import type { GlslChunk } from '../shader.ts';

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** Transfer curves (GLSL `int` ids = indexes). */
export const OCIO_CURVES = [
	'linear',
	'srgb',
	'rec709',
	'gamma24',
	'gamma22',
	'rec2020',
	'acescct',
	'logc3',
	'slog3',
	'vlog',
] as const;
export type OcioCurve = (typeof OCIO_CURVES)[number];

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const REC709_TO_AP0: Mat3 = [
	0.439632981919491, 0.382988698151554, 0.177378319928955, 0.0897764429588423, 0.813439428748981,
	0.0967841282921771, 0.0175411703831727, 0.111546553302387, 0.87091227631444,
];
const AP1_TO_AP0: Mat3 = [
	0.695452241357452, 0.14067869647027, 0.163869062172279, 0.0447945633720376, 0.859671118456422,
	0.0955343181715404, -0.00552588255811355, 0.00402521030597866, 1.00150067225214,
];
const REC2020_TO_AP1: Mat3 = [
	0.974894977924, 0.019599108637, 0.005505913439, 0.002179562798, 0.995535468893, 0.002284968309,
	0.004797239684, 0.024532016635, 0.970670743682,
];
const AWG3_TO_AP0: Mat3 = [
	0.680205505106279, 0.236136601606481, 0.0836578932872398, 0.0854149797421404, 1.01747087860704,
	-0.102885858349182, 0.00205652166929683, -0.0625625003847921, 1.06050597871549,
];
const SGAMUT3_TO_AP0: Mat3 = [
	0.75298259539984, 0.143370216235557, 0.103647188364603, 0.0217076974414429, 1.01531883550528,
	-0.0370265329467195, -0.00941605274963355, 0.00337041785882367, 1.00604563489081,
];
const VGAMUT_TO_AP0: Mat3 = [
	0.72461670413153, 0.166915288193706, 0.108468007674764, 0.021390245413146, 0.984908155703054,
	-0.00629840111620089, -0.00923556287076561, -0.00105690563900513, 1.01029246850977,
];

/** `a · b` (apply b first). */
export function mulMat3(a: Mat3, b: Mat3): Mat3 {
	const o: number[] = [];
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			o.push(a[3 * r]! * b[c]! + a[3 * r + 1]! * b[3 + c]! + a[3 * r + 2]! * b[6 + c]!);
	return o as unknown as Mat3;
}

export function invertMat3(m: Mat3): Mat3 {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (Math.abs(det) < 1e-12) return IDENTITY;
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
}

export const OCIO_GAMUTS = {
	rec709: REC709_TO_AP0,
	rec2020: mulMat3(AP1_TO_AP0, REC2020_TO_AP1),
	ap1: AP1_TO_AP0,
	ap0: IDENTITY,
	awg3: AWG3_TO_AP0,
	sgamut3: SGAMUT3_TO_AP0,
	vgamut: VGAMUT_TO_AP0,
} as const satisfies Record<string, Mat3>;
export type OcioGamut = keyof typeof OCIO_GAMUTS;

export type OcioSpace = { value: string; label: string; curve: OcioCurve; gamut: OcioGamut };

/** The built-in colour spaces (From / To popups), in menu order. */
export const OCIO_SPACES: readonly OcioSpace[] = [
	{ value: 'srgb', label: 'sRGB (Rec.709 primaries)', curve: 'srgb', gamut: 'rec709' },
	{ value: 'rec709', label: 'Rec.709 (BT.709 camera OETF)', curve: 'rec709', gamut: 'rec709' },
	{ value: 'rec1886', label: 'Rec.1886 / Gamma 2.4 (Rec.709)', curve: 'gamma24', gamut: 'rec709' },
	{ value: 'gamma22', label: 'Gamma 2.2 (Rec.709)', curve: 'gamma22', gamut: 'rec709' },
	{ value: 'linRec709', label: 'Linear Rec.709 (sRGB primaries)', curve: 'linear', gamut: 'rec709' },
	{ value: 'rec2020', label: 'Rec.2020 (BT.2020 OETF)', curve: 'rec2020', gamut: 'rec2020' },
	{ value: 'linRec2020', label: 'Linear Rec.2020', curve: 'linear', gamut: 'rec2020' },
	{ value: 'acescg', label: 'ACEScg (linear AP1)', curve: 'linear', gamut: 'ap1' },
	{ value: 'acescct', label: 'ACEScct (AP1)', curve: 'acescct', gamut: 'ap1' },
	{ value: 'aces2065', label: 'ACES2065-1 (linear AP0)', curve: 'linear', gamut: 'ap0' },
	{ value: 'logc3', label: 'ARRI LogC3 EI800 (ARRI Wide Gamut 3)', curve: 'logc3', gamut: 'awg3' },
	{ value: 'slog3', label: 'Sony S-Log3 (S-Gamut3)', curve: 'slog3', gamut: 'sgamut3' },
	{ value: 'vlog', label: 'Panasonic V-Log (V-Gamut)', curve: 'vlog', gamut: 'vgamut' },
];

export function ocioSpace(value: string): OcioSpace {
	return OCIO_SPACES.find((s) => s.value === value) ?? OCIO_SPACES[0]!;
}

/** The linear-light matrix from the primaries of `from` to those of `to` (row-major). */
export function ocioMatrix(from: OcioSpace, to: OcioSpace): Mat3 {
	if (from.gamut === to.gamut) return IDENTITY;
	return mulMat3(invertMat3(OCIO_GAMUTS[to.gamut]), OCIO_GAMUTS[from.gamut]);
}

/** Row-major → GLSL column-major (`{mat3}` uniforms). */
export const toColumnMajor = (m: Mat3): number[] => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

// ---------------------------------------------------------------- transfer curves (TS mirror of the GLSL)

const LOGC = {
	cut: 0.0105909904954696,
	a: 5.55555555555556,
	b: 0.0522722750251688,
	c: 0.247189638318671,
	d: 0.385536998692443,
	e: 5.367654795272978,
	f: 0.09280935699613731,
};
const SLOG3_TOE = 171.2102946929;
const VLOG = { cut1: 0.01, cut2: 0.181, b: 0.00873, c: 0.241514, d: 0.598206 };
const R2020 = { alpha: 1.09929682680944, beta: 0.018053968510807 };
const CCT = { a: 10.5402377416545, b: 0.0729055341958355, cut: 0.0078125, ycut: 0.155251141552511 };

const spow = (x: number, g: number) => Math.sign(x) * Math.abs(x) ** g;

/** Encoded value → linear light. */
export function ocioDecode(curve: OcioCurve, v: number): number {
	switch (curve) {
		case 'srgb':
			return Math.abs(v) <= 0.04045 ? v / 12.92 : Math.sign(v) * ((Math.abs(v) + 0.055) / 1.055) ** 2.4;
		case 'rec709':
			return v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45);
		case 'gamma24':
			return spow(v, 2.4);
		case 'gamma22':
			return spow(v, 2.2);
		case 'rec2020':
			return v < 4.5 * R2020.beta ? v / 4.5 : ((v + R2020.alpha - 1) / R2020.alpha) ** (1 / 0.45);
		case 'acescct':
			if (v <= CCT.ycut) return (v - CCT.b) / CCT.a;
			if (v < 1.4679963120447153) return 2 ** (v * 17.52 - 9.72);
			return 65504;
		case 'logc3':
			return v > LOGC.e * LOGC.cut + LOGC.f
				? (10 ** ((v - LOGC.d) / LOGC.c) - LOGC.b) / LOGC.a
				: (v - LOGC.f) / LOGC.e;
		case 'slog3':
			return v >= SLOG3_TOE / 1023
				? 10 ** ((v * 1023 - 420) / 261.5) * 0.19 - 0.01
				: ((v * 1023 - 95) * 0.01125) / (SLOG3_TOE - 95);
		case 'vlog':
			return v < VLOG.cut2 ? (v - 0.125) / 5.6 : 10 ** ((v - VLOG.d) / VLOG.c) - VLOG.b;
		default:
			return v;
	}
}

/** Linear light → encoded value. */
export function ocioEncode(curve: OcioCurve, x: number): number {
	switch (curve) {
		case 'srgb':
			return Math.abs(x) <= 0.0031308 ? x * 12.92 : Math.sign(x) * (1.055 * Math.abs(x) ** (1 / 2.4) - 0.055);
		case 'rec709':
			return x < 0.018 ? 4.5 * x : 1.099 * x ** 0.45 - 0.099;
		case 'gamma24':
			return spow(x, 1 / 2.4);
		case 'gamma22':
			return spow(x, 1 / 2.2);
		case 'rec2020':
			return x < R2020.beta ? 4.5 * x : R2020.alpha * x ** 0.45 - (R2020.alpha - 1);
		case 'acescct':
			return x <= CCT.cut ? CCT.a * x + CCT.b : (Math.log2(x) + 9.72) / 17.52;
		case 'logc3':
			return x > LOGC.cut ? LOGC.c * Math.log10(LOGC.a * x + LOGC.b) + LOGC.d : LOGC.e * x + LOGC.f;
		case 'slog3':
			return x >= 0.01125
				? (420 + Math.log10((x + 0.01) / 0.19) * 261.5) / 1023
				: (x * ((SLOG3_TOE - 95) / 0.01125) + 95) / 1023;
		case 'vlog':
			return x < VLOG.cut1 ? 5.6 * x + 0.125 : VLOG.c * Math.log10(x + VLOG.b) + VLOG.d;
		default:
			return x;
	}
}

/** One full conversion of a straight RGB triple (TS reference of the shader, used by tests). */
export function ocioConvert(from: OcioSpace, to: OcioSpace, rgb: readonly [number, number, number]) {
	const m = ocioMatrix(from, to);
	const lin = rgb.map((v) => ocioDecode(from.curve, v));
	const out = [0, 1, 2].map((r) => m[3 * r]! * lin[0]! + m[3 * r + 1]! * lin[1]! + m[3 * r + 2]! * lin[2]!);
	return out.map((v) => ocioEncode(to.curve, v)) as [number, number, number];
}

// ---------------------------------------------------------------- GLSL

const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const GLSL_SAC_OCIO: GlslChunk = {
	name: 'sapphire-adjust-composite/ocio',
	source: /* glsl */ `
float sac_spow(float x, float g) { return sign(x) * pow(abs(x), g); }
float sac_ocioDecode(int k, float v) {
  if (k == 1) return abs(v) <= 0.04045 ? v / 12.92 : sign(v) * pow((abs(v) + 0.055) / 1.055, 2.4);
  if (k == 2) return v < 0.081 ? v / 4.5 : pow((v + 0.099) / 1.099, 1.0 / 0.45);
  if (k == 3) return sac_spow(v, 2.4);
  if (k == 4) return sac_spow(v, 2.2);
  if (k == 5) return v < ${f(4.5 * R2020.beta)} ? v / 4.5 : pow((v + ${f(R2020.alpha - 1)}) / ${f(R2020.alpha)}, 1.0 / 0.45);
  if (k == 6) {
    if (v <= ${f(CCT.ycut)}) return (v - ${f(CCT.b)}) / ${f(CCT.a)};
    if (v < 1.4679963120447153) return exp2(v * 17.52 - 9.72);
    return 65504.0;
  }
  if (k == 7) return v > ${f(LOGC.e * LOGC.cut + LOGC.f)} ? (pow(10.0, (v - ${f(LOGC.d)}) / ${f(LOGC.c)}) - ${f(LOGC.b)}) / ${f(LOGC.a)} : (v - ${f(LOGC.f)}) / ${f(LOGC.e)};
  if (k == 8) return v >= ${f(SLOG3_TOE / 1023)} ? pow(10.0, (v * 1023.0 - 420.0) / 261.5) * 0.19 - 0.01 : (v * 1023.0 - 95.0) * 0.01125 / ${f(SLOG3_TOE - 95)};
  if (k == 9) return v < ${f(VLOG.cut2)} ? (v - 0.125) / 5.6 : pow(10.0, (v - ${f(VLOG.d)}) / ${f(VLOG.c)}) - ${f(VLOG.b)};
  return v;
}
float sac_log10(float x) { return log2(x) * 0.30102999566398120; }
float sac_ocioEncode(int k, float x) {
  if (k == 1) return abs(x) <= 0.0031308 ? x * 12.92 : sign(x) * (1.055 * pow(abs(x), 1.0 / 2.4) - 0.055);
  if (k == 2) return x < 0.018 ? 4.5 * x : 1.099 * pow(x, 0.45) - 0.099;
  if (k == 3) return sac_spow(x, 1.0 / 2.4);
  if (k == 4) return sac_spow(x, 1.0 / 2.2);
  if (k == 5) return x < ${f(R2020.beta)} ? 4.5 * x : ${f(R2020.alpha)} * pow(x, 0.45) - ${f(R2020.alpha - 1)};
  if (k == 6) return x <= ${f(CCT.cut)} ? ${f(CCT.a)} * x + ${f(CCT.b)} : (log2(x) + 9.72) / 17.52;
  if (k == 7) return x > ${f(LOGC.cut)} ? ${f(LOGC.c)} * sac_log10(${f(LOGC.a)} * x + ${f(LOGC.b)}) + ${f(LOGC.d)} : ${f(LOGC.e)} * x + ${f(LOGC.f)};
  if (k == 8) return x >= 0.01125 ? (420.0 + sac_log10((x + 0.01) / 0.19) * 261.5) / 1023.0 : (x * ${f((SLOG3_TOE - 95) / 0.01125)} + 95.0) / 1023.0;
  if (k == 9) return x < ${f(VLOG.cut1)} ? 5.6 * x + 0.125 : ${f(VLOG.c)} * sac_log10(x + ${f(VLOG.b)}) + ${f(VLOG.d)};
  return x;
}
vec3 sac_ocioDecode3(int k, vec3 v) { return vec3(sac_ocioDecode(k, v.r), sac_ocioDecode(k, v.g), sac_ocioDecode(k, v.b)); }
vec3 sac_ocioEncode3(int k, vec3 x) { return vec3(sac_ocioEncode(k, x.r), sac_ocioEncode(k, x.g), sac_ocioEncode(k, x.b)); }
`,
};

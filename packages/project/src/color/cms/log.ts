// Camera log curves, each implemented from the manufacturer's published document. Every curve
// is `encode(x) → signal` / `decode(signal) → x` with x = scene-linear reflectance (18 % grey = 0.18) and the
// signal in the curve's own normalisation ("domain"):
//   'cv'  — 10-bit code value / 1023 (full scale): Sony, Panasonic, ARRI, DJI, RED, Blackmagic, Fujifilm, Nikon;
//   'ire' — video-range normalised (code 64 → 0, code 940 → 1): Canon Log/Log 2/Log 3, Sony S-Log/S-Log2, Apple Log.
// `signalFromNormalized` converts a decoder's normalised value (which already accounts for the file's range flag)
// into the curve domain, so the same formulas serve limited- and full-range files.
//
// Sources (see docs/wp-notes/color-mgmt.md for the full table):
//   S-Log3        Sony, "Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3" (2014)
//   S-Log, S-Log2 Sony, "S-Log: A new LUT for digital production mastering and interchange applications" (2009) and
//                 "S-Log2 Technical Paper" (2012): S-Log2 = S-Log of x·155/219, x = reflectance / 0.9
//   V-Log         Panasonic, "V-Log/V-Gamut Reference Manual" rev. 1.0 (2014)
//   Canon Log 1/2/3  Canon, "Canon Log Gamma Curves — Description of the Canon Log, Canon Log 2 and Canon Log 3" (2018)
//   LogC3 (EI 800) ARRI, "ALEXA Log C Curve — Usage in VFX" (2017), EI 800 row
//   LogC4         ARRI, "ARRI LogC4 Logarithmic Color Space — Specification" (2022)
//   Apple Log     Apple, "Apple Log Profile" white paper (2023)
//   D-Log         DJI, "White Paper on D-Log and D-Gamut of DJI Cinema Color System" (2017)
//   Log3G10       RED, "REDWideGamutRGB and Log3G10" white paper (2017, v2 curve: a, b, c, g below)
//   Film Gen 5    Blackmagic Design, "Blackmagic Generation 5 Color Science" (2021)
//   DaVinci Intermediate  Blackmagic Design, "DaVinci Resolve 17 — Wide Gamut Intermediate" (2020)
//   F-Log / F-Log2 Fujifilm, "F-Log Data Sheet" Ver.1.0 (2016) / "F-Log2 Data Sheet" Ver.1.0 (2022)
//   N-Log         Nikon, "N-Log Specification Document" Ver.1.0.0 (2018)
//   Cineon        Kodak, "Conversion of 10-bit Log Film Data To 8-bit Linear or Video Data for the Cineon Digital Film
//                 System" (1995): reference white 685, black 95, 0.002 density per code value, gamma 0.6
// Ported (S-Log3, V-Log, Canon Log 2/3, LogC3, LogC4, Apple Log, D-Log) from FilmCraft `crates/color/src/log.rs`
// (MIT OR Apache-2.0); the others are new here.

export type LogDomain = 'cv' | 'ire';

type LogDef = { label: string; domain: LogDomain; encode(x: number): number; decode(y: number): number };

const SLOG3_TOE = 171.2102946929;
function slog3Encode(x: number): number {
	return x >= 0.01125
		? (420 + Math.log10((x + 0.01) / (0.18 + 0.01)) * 261.5) / 1023
		: (x * (SLOG3_TOE - 95)) / 0.01125 / 1023 + 95 / 1023;
}
function slog3Decode(y: number): number {
	return y >= SLOG3_TOE / 1023
		? 10 ** ((y * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01
		: ((y * 1023 - 95) * 0.01125) / (SLOG3_TOE - 95);
}
const SLOG_TOE = 0.030001222851889303;
/** Sony S-Log (S-Log1) of `t` = reflectance / 0.9, IRE. */
function slogCore(t: number): number {
	return t >= 0 ? 0.432699 * Math.log10(t + 0.037584) + 0.616596 + 0.03 : t * 5 + SLOG_TOE;
}
function slogCoreInv(y: number): number {
	return y >= SLOG_TOE ? 10 ** ((y - 0.616596 - 0.03) / 0.432699) - 0.037584 : (y - SLOG_TOE) / 5;
}

const VLOG = { b: 0.00873, c: 0.241514, d: 0.598206 };

// Canon (x = reflectance / 0.9, IRE)
function clogEncode(r: number): number {
	const x = r / 0.9;
	return x < 0
		? -0.45310179 * Math.log10(-10.1596 * x + 1) + 0.12512248
		: 0.45310179 * Math.log10(10.1596 * x + 1) + 0.12512248;
}
function clogDecode(y: number): number {
	const x =
		y < 0.12512248
			? -(10 ** ((0.12512248 - y) / 0.45310179) - 1) / 10.1596
			: (10 ** ((y - 0.12512248) / 0.45310179) - 1) / 10.1596;
	return x * 0.9;
}
function clog2Encode(r: number): number {
	const x = r / 0.9;
	return x < 0
		? -0.24136077 * Math.log10(-x * 87.09937546 + 1) + 0.092864125
		: 0.24136077 * Math.log10(x * 87.09937546 + 1) + 0.092864125;
}
function clog2Decode(y: number): number {
	const x =
		y < 0.092864125
			? -(10 ** ((0.092864125 - y) / 0.24136077) - 1) / 87.09937546
			: (10 ** ((y - 0.092864125) / 0.24136077) - 1) / 87.09937546;
	return x * 0.9;
}
function clog3Encode(r: number): number {
	const x = r / 0.9;
	if (x < -0.014) return -0.36726845 * Math.log10(-x * 14.98325 + 1) + 0.12783901;
	if (x <= 0.014) return 1.9754798 * x + 0.12512219;
	return 0.36726845 * Math.log10(x * 14.98325 + 1) + 0.12240537;
}
function clog3Decode(y: number): number {
	let x: number;
	if (y < 0.097465473) x = -(10 ** ((0.12783901 - y) / 0.36726845) - 1) / 14.98325;
	else if (y <= 0.15277891) x = (y - 0.12512219) / 1.9754798;
	else x = (10 ** ((y - 0.12240537) / 0.36726845) - 1) / 14.98325;
	return x * 0.9;
}

const LOGC3 = { cut: 0.010591, a: 5.555556, b: 0.052272, c: 0.24719, d: 0.385537, e: 5.367655, f: 0.092809 };
const LC4_A = (2 ** 18 - 16) / 117.45;
const LC4_B = (1023 - 95) / 1023;
const LC4_C = 95 / 1023;
const LC4_S = (7 * Math.LN2 * 2 ** (7 - (14 * LC4_C) / LC4_B)) / (LC4_A * LC4_B);
const LC4_T = (2 ** ((14 * -LC4_C) / LC4_B + 6) - 64) / LC4_A;

const APPLE = {
	r0: -0.05641088,
	rt: 0.01,
	c: 47.28711236,
	beta: 0.00964052,
	gamma: 0.08550479,
	delta: 0.69336945,
};
const APPLE_PT = APPLE.c * (APPLE.rt - APPLE.r0) ** 2;

// RED Log3G10 (v2)
const L3G10 = { a: 0.224282, b: 155.975327, c: 0.01, g: 15.1927 };

const BMD5 = {
	a: 0.08692876065491224,
	b: 0.005494072432257808,
	c: 0.5300133392291939,
	d: 8.283605932402494,
	e: 0.09246575342465753,
	linCut: 0.005,
};
const BMD5_LOG_CUT = BMD5.d * BMD5.linCut + BMD5.e;
const DI = { a: 0.0075, b: 7, c: 0.07329248, m: 10.44426855, linCut: 0.00262409, logCut: 0.02740668 };

const FLOG = { a: 0.555556, b: 0.009468, c: 0.344676, d: 0.790453, e: 8.735631, f: 0.092864, cut1: 0.00089 };
const FLOG2 = {
	a: 5.555556,
	b: 0.064829,
	c: 0.245281,
	d: 0.384316,
	e: 8.799461,
	f: 0.092864,
	cut1: 0.000889,
};
function fEncode(k: typeof FLOG, x: number): number {
	return x >= k.cut1 ? k.c * Math.log10(k.a * x + k.b) + k.d : k.e * x + k.f;
}
function fDecode(k: typeof FLOG, y: number): number {
	const cut2 = k.e * k.cut1 + k.f;
	return y >= cut2 ? (10 ** ((y - k.d) / k.c) - k.b) / k.a : (y - k.f) / k.e;
}

const NLOG = { cut1: 0.328, a: 650 / 1023, b: 0.0075, c: 150 / 1023, d: 619 / 1023 };
const NLOG_CUT2 = NLOG.a * Math.cbrt(NLOG.cut1 + NLOG.b);

// Kodak Cineon (DPX printing density)
const CINEON_BLACK = 10 ** (((95 - 685) * 0.002) / 0.6);

function dlogEncode(x: number): number {
	return x <= 0.0078 ? 6.025 * x + 0.0929 : Math.log10(x * 0.9892 + 0.0108) * 0.256663 + 0.584555;
}
function dlogDecode(y: number): number {
	return y <= 0.14 ? (y - 0.0929) / 6.025 : (10 ** (3.89616 * y - 2.27752) - 0.0108) / 0.9892;
}

export const LOG_CURVES = {
	slog3: { label: 'Sony S-Log3', domain: 'cv', encode: slog3Encode, decode: slog3Decode },
	slog2: {
		label: 'Sony S-Log2',
		domain: 'ire',
		encode: (x: number) => slogCore((x * 155) / 219 / 0.9),
		decode: (y: number) => (slogCoreInv(y) * 0.9 * 219) / 155,
	},
	slog: {
		label: 'Sony S-Log',
		domain: 'ire',
		encode: (x: number) => slogCore(x / 0.9),
		decode: (y: number) => slogCoreInv(y) * 0.9,
	},
	vlog: {
		label: 'Panasonic V-Log',
		domain: 'cv',
		encode: (x: number) => (x < 0.01 ? 5.6 * x + 0.125 : VLOG.c * Math.log10(x + VLOG.b) + VLOG.d),
		decode: (y: number) => (y < 0.181 ? (y - 0.125) / 5.6 : 10 ** ((y - VLOG.d) / VLOG.c) - VLOG.b),
	},
	clog: { label: 'Canon Log', domain: 'ire', encode: clogEncode, decode: clogDecode },
	clog2: { label: 'Canon Log 2', domain: 'ire', encode: clog2Encode, decode: clog2Decode },
	clog3: { label: 'Canon Log 3', domain: 'ire', encode: clog3Encode, decode: clog3Decode },
	logc3: {
		label: 'ARRI LogC3 (EI 800)',
		domain: 'cv',
		encode: (x: number) =>
			x > LOGC3.cut ? LOGC3.c * Math.log10(LOGC3.a * x + LOGC3.b) + LOGC3.d : LOGC3.e * x + LOGC3.f,
		decode: (t: number) =>
			t > LOGC3.e * LOGC3.cut + LOGC3.f
				? (10 ** ((t - LOGC3.d) / LOGC3.c) - LOGC3.b) / LOGC3.a
				: (t - LOGC3.f) / LOGC3.e,
	},
	logc4: {
		label: 'ARRI LogC4',
		domain: 'cv',
		encode: (x: number) =>
			x >= LC4_T ? ((Math.log2(LC4_A * x + 64) - 6) / 14) * LC4_B + LC4_C : (x - LC4_T) / LC4_S,
		decode: (y: number) =>
			y >= 0 ? (2 ** ((14 * (y - LC4_C)) / LC4_B + 6) - 64) / LC4_A : y * LC4_S + LC4_T,
	},
	applelog: {
		label: 'Apple Log',
		domain: 'ire',
		encode: (r: number) => {
			if (r >= APPLE.rt) return APPLE.gamma * Math.log2(r + APPLE.beta) + APPLE.delta;
			if (r >= APPLE.r0) return APPLE.c * (r - APPLE.r0) ** 2;
			return 0;
		},
		decode: (p: number) => {
			if (p >= APPLE_PT) return 2 ** ((p - APPLE.delta) / APPLE.gamma) - APPLE.beta;
			if (p >= 0) return Math.sqrt(p / APPLE.c) + APPLE.r0;
			return APPLE.r0;
		},
	},
	dlog: { label: 'DJI D-Log', domain: 'cv', encode: dlogEncode, decode: dlogDecode },
	log3g10: {
		label: 'RED Log3G10',
		domain: 'cv',
		encode: (x: number) => {
			const t = x + L3G10.c;
			return t < 0 ? t * L3G10.g : L3G10.a * Math.log10(t * L3G10.b + 1);
		},
		decode: (y: number) => (y < 0 ? y / L3G10.g - L3G10.c : (10 ** (y / L3G10.a) - 1) / L3G10.b - L3G10.c),
	},
	bmdfilm5: {
		label: 'Blackmagic Film Gen 5',
		domain: 'cv',
		encode: (x: number) => (x < BMD5.linCut ? BMD5.d * x + BMD5.e : BMD5.a * Math.log(x + BMD5.b) + BMD5.c),
		decode: (y: number) =>
			y < BMD5_LOG_CUT ? (y - BMD5.e) / BMD5.d : Math.exp((y - BMD5.c) / BMD5.a) - BMD5.b,
	},
	davinci: {
		label: 'DaVinci Intermediate',
		domain: 'cv',
		encode: (x: number) => (x <= DI.linCut ? x * DI.m : (Math.log2(x + DI.a) + DI.b) * DI.c),
		decode: (y: number) => (y <= DI.logCut ? y / DI.m : 2 ** (y / DI.c - DI.b) - DI.a),
	},
	flog: {
		label: 'Fujifilm F-Log',
		domain: 'cv',
		encode: (x: number) => fEncode(FLOG, x),
		decode: (y: number) => fDecode(FLOG, y),
	},
	flog2: {
		label: 'Fujifilm F-Log2',
		domain: 'cv',
		encode: (x: number) => fEncode(FLOG2, x),
		decode: (y: number) => fDecode(FLOG2, y),
	},
	cineon: {
		label: 'Cineon log',
		domain: 'cv',
		encode: (x: number) =>
			(685 + (Math.log10(Math.max(1e-9, x * (1 - CINEON_BLACK) + CINEON_BLACK)) * 0.6) / 0.002) / 1023,
		decode: (y: number) => (10 ** (((y * 1023 - 685) * 0.002) / 0.6) - CINEON_BLACK) / (1 - CINEON_BLACK),
	},
	nlog: {
		label: 'Nikon N-Log',
		domain: 'cv',
		encode: (x: number) =>
			x < NLOG.cut1 ? NLOG.a * Math.cbrt(x + NLOG.b) : NLOG.c * Math.log(Math.max(x, 1e-12)) + NLOG.d,
		decode: (y: number) => (y < NLOG_CUT2 ? (y / NLOG.a) ** 3 - NLOG.b : Math.exp((y - NLOG.d) / NLOG.c)),
	},
} as const satisfies Record<string, LogDef>;

export type LogCurveId = keyof typeof LOG_CURVES;
export const LOG_CURVE_IDS = Object.keys(LOG_CURVES) as LogCurveId[];

export function logEncode(id: LogCurveId, x: number): number {
	return LOG_CURVES[id].encode(x);
}
export function logDecode(id: LogCurveId, y: number): number {
	return LOG_CURVES[id].decode(y);
}

/** Decoder-normalised value (0..1 in the file's range) → curve-domain signal. */
export function signalFromNormalized(v: number, range: 'tv' | 'pc', domain: LogDomain): number {
	if (range === 'tv' && domain === 'cv') return (64 + 876 * v) / 1023;
	if (range === 'pc' && domain === 'ire') return (1023 * v - 64) / 876;
	return v;
}
/** Curve-domain signal → decoder-normalised value (0..1 in the file's range). */
export function normalizedFromSignal(s: number, range: 'tv' | 'pc', domain: LogDomain): number {
	if (range === 'tv' && domain === 'cv') return (1023 * s - 64) / 876;
	if (range === 'pc' && domain === 'ire') return (64 + 876 * s) / 1023;
	return s;
}

/** Scene-linear value of the largest signal (10-bit code 1023), the curve's own peak. */
export function logPeakLinear(id: LogCurveId): number {
	const c = LOG_CURVES[id];
	return c.decode(c.domain === 'cv' ? 1 : (1023 - 64) / 876);
}

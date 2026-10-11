// Transfer functions of display, HDR and ACES encodings. Each curve is a pair
// `decode(signal) → linear` / `encode(linear) → signal` of the published standard; the display curves extend to
// negative values by mirroring (over-range float values survive a round trip). Camera log curves are in `log.ts`.
//
// Sources:
//   sRGB          IEC 61966-2-1:1999 §5.2 (piecewise, 0.04045 / 12.92 / 2.4).
//   BT.1886       ITU-R BT.1886-0 Annex 1 with Lb = 0, Lw = 1: L = V^2.4 (the display EOTF of Rec.709 / Rec.2020).
//   BT.709 OETF   ITU-R BT.709-6 §1.2 (camera: 4.5·L below 0.018, 1.099·L^0.45 − 0.099 above).
//   BT.2020 OETF  ITU-R BT.2020-2 Table 4 (α = 1.09929682680944, β = 0.018053968510807).
//   PQ            SMPTE ST 2084:2014 / ITU-R BT.2100-2 Table 4 (m1 = 2610/16384, m2 = 2523/4096·128, c1 = 3424/4096,
//                 c2 = 2413/4096·32, c3 = 2392/4096·32); linear = absolute luminance / 10 000 cd/m².
//   HLG           ITU-R BT.2100-2 Table 5 (a = 0.17883277, b = 1 − 4a, c = 0.5 − a·ln(4a)); OOTF Note 5e/5f.
//   ACEScct       Academy S-2016-001 (ACEScct, AP1).
//   ACEScc        Academy S-2014-003 (ACEScc, AP1).
import { LOG_CURVES, type LogCurveId, logDecode, logEncode } from './log.ts';

export type CurveId =
	| 'linear'
	| 'srgb'
	| 'bt1886'
	| 'gamma22'
	| 'gamma26'
	| 'bt709'
	| 'bt2020'
	| 'pq'
	| 'hlg'
	| 'acescct'
	| 'acescc'
	| LogCurveId;

const spow = (x: number, g: number) => (x < 0 ? -((-x) ** g) : x ** g);

export function srgbDecode(v: number): number {
	const a = Math.abs(v);
	const l = a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4;
	return v < 0 ? -l : l;
}
export function srgbEncode(x: number): number {
	const a = Math.abs(x);
	const v = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
	return x < 0 ? -v : v;
}

// BT.709 / BT.2020 camera OETF
const B709 = { alpha: 1.099, beta: 0.018 };
const B2020 = { alpha: 1.09929682680944, beta: 0.018053968510807 };
function oetfEncode(x: number, k: { alpha: number; beta: number }): number {
	const a = Math.abs(x);
	const v = a < k.beta ? 4.5 * a : k.alpha * a ** 0.45 - (k.alpha - 1);
	return x < 0 ? -v : v;
}
function oetfDecode(v: number, k: { alpha: number; beta: number }): number {
	const a = Math.abs(v);
	const l = a < 4.5 * k.beta ? a / 4.5 : ((a + k.alpha - 1) / k.alpha) ** (1 / 0.45);
	return v < 0 ? -l : l;
}

// PQ (SMPTE ST 2084)
export const PQ_M1 = 2610 / 16384;
export const PQ_M2 = (2523 / 4096) * 128;
export const PQ_C1 = 3424 / 4096;
export const PQ_C2 = (2413 / 4096) * 32;
export const PQ_C3 = (2392 / 4096) * 32;
/** PQ signal → absolute luminance / 10 000 cd/m² (EOTF). */
export function pqDecode(e: number): number {
	const p = Math.max(0, e) ** (1 / PQ_M2);
	return (Math.max(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p)) ** (1 / PQ_M1);
}
/** Absolute luminance / 10 000 cd/m² → PQ signal (inverse EOTF). */
export function pqEncode(y: number): number {
	const p = Math.max(0, y) ** PQ_M1;
	return ((PQ_C1 + PQ_C2 * p) / (1 + PQ_C3 * p)) ** PQ_M2;
}
export const pqFromNits = (nits: number) => pqEncode(nits / 10000);
export const nitsFromPq = (e: number) => pqDecode(e) * 10000;

// HLG (ARIB STD-B67 / BT.2100)
export const HLG_A = 0.17883277;
export const HLG_B = 1 - 4 * HLG_A;
export const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);
/** HLG OETF: normalised scene light E (0..1) → signal. */
export function hlgEncode(e: number): number {
	const x = Math.max(0, e);
	return x <= 1 / 12 ? Math.sqrt(3 * x) : HLG_A * Math.log(12 * x - HLG_B) + HLG_C;
}
/** HLG inverse OETF: signal → normalised scene light E. */
export function hlgDecode(v: number): number {
	const x = Math.max(0, v);
	return x <= 0.5 ? (x * x) / 3 : (Math.exp((x - HLG_C) / HLG_A) + HLG_B) / 12;
}
/** BT.2100 Note 5f: HLG system gamma for a display of nominal peak `lw` cd/m² (1.2 at 1000). */
export function hlgSystemGamma(lw: number): number {
	return 1.2 + 0.42 * Math.log10(Math.max(1, lw) / 1000);
}

const CCT_A = 10.5402377416545;
const CCT_B = 0.0729055341958355;
const CCT_X_BRK = 0.0078125;
const CCT_Y_BRK = 0.155251141552511;
const ACES_HALF_MAX = 65504;
export function acescctEncode(x: number): number {
	return x <= CCT_X_BRK ? CCT_A * x + CCT_B : (Math.log2(x) + 9.72) / 17.52;
}
export function acescctDecode(y: number): number {
	if (y <= CCT_Y_BRK) return (y - CCT_B) / CCT_A;
	if (y < (Math.log2(ACES_HALF_MAX) + 9.72) / 17.52) return 2 ** (y * 17.52 - 9.72);
	return ACES_HALF_MAX;
}
export function accEncode(x: number): number {
	if (x <= 0) return (-16 + 9.72) / 17.52;
	if (x < 2 ** -15) return (Math.log2(2 ** -16 + x * 0.5) + 9.72) / 17.52;
	return (Math.log2(x) + 9.72) / 17.52;
}
export function accDecode(y: number): number {
	if (y < (9.72 - 15) / 17.52) return (2 ** (y * 17.52 - 9.72) - 2 ** -16) * 2;
	if (y < (Math.log2(ACES_HALF_MAX) + 9.72) / 17.52) return 2 ** (y * 17.52 - 9.72);
	return ACES_HALF_MAX;
}

/** Signal → linear. PQ gives absolute / 10 000 cd/m², HLG scene light E, logs scene-linear reflectance. */
export function curveDecode(curve: CurveId, v: number): number {
	switch (curve) {
		case 'linear':
			return v;
		case 'srgb':
			return srgbDecode(v);
		case 'bt1886':
			return spow(v, 2.4);
		case 'gamma22':
			return spow(v, 2.2);
		case 'gamma26':
			return spow(v, 2.6);
		case 'bt709':
			return oetfDecode(v, B709);
		case 'bt2020':
			return oetfDecode(v, B2020);
		case 'pq':
			return pqDecode(v);
		case 'hlg':
			return hlgDecode(v);
		case 'acescct':
			return acescctDecode(v);
		case 'acescc':
			return accDecode(v);
		default:
			return logDecode(curve, v);
	}
}

/** Linear → signal (inverse of `curveDecode`). */
export function curveEncode(curve: CurveId, x: number): number {
	switch (curve) {
		case 'linear':
			return x;
		case 'srgb':
			return srgbEncode(x);
		case 'bt1886':
			return spow(x, 1 / 2.4);
		case 'gamma22':
			return spow(x, 1 / 2.2);
		case 'gamma26':
			return spow(x, 1 / 2.6);
		case 'bt709':
			return oetfEncode(x, B709);
		case 'bt2020':
			return oetfEncode(x, B2020);
		case 'pq':
			return pqEncode(x);
		case 'hlg':
			return hlgEncode(x);
		case 'acescct':
			return acescctEncode(x);
		case 'acescc':
			return accEncode(x);
		default:
			return logEncode(curve, x);
	}
}

export function isLogCurve(curve: CurveId): curve is LogCurveId {
	return curve in LOG_CURVES;
}

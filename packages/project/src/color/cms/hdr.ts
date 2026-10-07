// HDR tone mapping and gamut mapping (workstream color-mgmt).
// - ITU-R BT.2390-10 §5.4.1 EETF: a Hermite knee in the PQ domain from a source display peak to a target peak (black
//   levels 0), applied to max(R, G, B) as a ratio so hue and saturation are kept (ported from FilmCraft
//   `crates/color/src/transform.rs`, MIT OR Apache-2.0).
// - Gamut compression after the ACES Reference Gamut Compression 1.0 (Academy, 2022): per-channel distance from the
//   achromatic axis, thresholds (0.815, 0.803, 0.880), limits (1.147, 1.264, 1.312), power 1.2. FilmCraft used one
//   threshold/limit for all channels; these are the published per-channel values.
// - Luminance-preserving desaturation into a display gamut (FilmCraft `desaturate_into_gamut`): in-gamut colours come
//   back exactly.
import { pqDecode, pqEncode } from './transfer.ts';

/** ITU-R BT.2408 HDR reference white (cd/m²): working-linear 1.0 in HDR, SDR white mapped into HDR. */
export const REFERENCE_WHITE_NITS = 203;
/** BT.2100 nominal HLG display peak, and the mastering peak assumed for PQ media without metadata. */
export const DEFAULT_HDR_PEAK_NITS = 1000;
/** Source peak cap for scene-referred (log) media, so the BT.2390 knee starts above mid grey. */
export const LOG_PEAK_NITS = 4000;

const pqN = (nits: number) => pqEncode(Math.min(1, Math.max(0, nits / 10000)));

/** BT.2390 EETF: cd/m² on a display of peak `srcPeak` → cd/m² on one of peak `dstPeak` (identity if dst ≥ src). */
export function bt2390Eetf(nits: number, srcPeak: number, dstPeak: number): number {
	if (!(nits > 0)) return 0;
	if (dstPeak >= srcPeak) return Math.min(nits, Math.max(srcPeak, dstPeak));
	const smax = pqN(srcPeak);
	const e1 = Math.min(pqN(nits) / smax, 1);
	const maxLum = pqN(dstPeak) / smax;
	const ks = 1.5 * maxLum - 0.5;
	let e2: number;
	if (e1 < ks) e2 = e1;
	else {
		const t = (e1 - ks) / (1 - ks);
		const t2 = t * t;
		const t3 = t2 * t;
		e2 = (2 * t3 - 3 * t2 + 1) * ks + (t3 - 2 * t2 + t) * (1 - ks) + (-2 * t3 + 3 * t2) * maxLum;
	}
	return pqDecode(e2 * smax) * 10000;
}

/**
 * Tone mapping of an RGB triple in cd/m² (in place): BT.2390 on max(R, G, B), applied as a ratio. Above the source
 * peak the colour is clipped to the target peak.
 */
export function toneMapNits(c: [number, number, number], srcPeak: number, dstPeak: number): void {
	if (dstPeak >= srcPeak) return;
	const m = Math.max(c[0], c[1], c[2]);
	if (!(m > 0)) return;
	const k = m >= srcPeak ? dstPeak / m : bt2390Eetf(m, srcPeak, dstPeak) / m;
	c[0] *= k;
	c[1] *= k;
	c[2] *= k;
}

const RGC_TH = [0.815, 0.803, 0.88] as const;
const RGC_LIM = [1.147, 1.264, 1.312] as const;
const RGC_PWR = 1.2;
const RGC_SCALE = RGC_TH.map(
	(th, i) => (RGC_LIM[i]! - th) / (((1 - th) / (RGC_LIM[i]! - th)) ** -RGC_PWR - 1) ** (1 / RGC_PWR),
);

/** ACES Reference Gamut Compression (in place): out-of-gamut colours towards the achromatic axis, inner 80 % kept. */
export function gamutCompress(c: [number, number, number]): void {
	const ach = Math.max(c[0], c[1], c[2]);
	if (!(ach > 1e-12)) {
		for (let k = 0; k < 3; k++) if (c[k]! < 0) c[k] = 0;
		return;
	}
	for (let k = 0; k < 3; k++) {
		const d = (ach - c[k]!) / ach;
		const th = RGC_TH[k]!;
		if (d < th) continue;
		const s = RGC_SCALE[k]!;
		const x = (d - th) / s;
		const dc = th + (s * x) / (1 + x ** RGC_PWR) ** (1 / RGC_PWR);
		c[k] = ach - dc * ach;
	}
}

/**
 * Desaturate towards the luminance (`luma` = the target gamut's Y weights) just enough that no component is negative
 * (in place). Hue and luminance are kept; in-gamut colours are unchanged.
 */
export function desaturateIntoGamut(
	c: [number, number, number],
	luma: readonly [number, number, number],
): void {
	const mn = Math.min(c[0], c[1], c[2]);
	if (mn >= 0) return;
	const y = luma[0] * c[0] + luma[1] * c[1] + luma[2] * c[2];
	if (!(y > 0)) {
		c[0] = 0;
		c[1] = 0;
		c[2] = 0;
		return;
	}
	const t = y / (y - mn);
	for (let k = 0; k < 3; k++) c[k] = Math.max(0, y + (c[k]! - y) * t);
}

/** HDR static metadata (SMPTE ST 2086 + CTA-861.3), cd/m²; absent or 0 = unknown. */
export type HdrStaticMetadata = {
	masteringMaxNits?: number;
	masteringMinNits?: number;
	maxCll?: number;
	maxFall?: number;
};

/**
 * Tone-mapping source peak of PQ media: MaxCLL when signalled (capped by the mastering peak), else the mastering
 * peak, clamped to 203…10 000 cd/m²; null without metadata (FilmCraft `HdrMetadata::peak_nits`).
 */
export function hdrPeakNits(m: HdrStaticMetadata | null | undefined): number | null {
	const known = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
	const cll = known(m?.maxCll);
	const mast = known(m?.masteringMaxNits);
	const p = cll !== null && mast !== null ? Math.min(cll, mast) : (cll ?? mast);
	return p === null ? null : Math.min(10000, Math.max(REFERENCE_WHITE_NITS, p));
}

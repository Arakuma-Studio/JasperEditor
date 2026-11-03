// Colour-managed conversions between a source space, the sequence working space and an
// output (display or export) space. The composite holds the *working space's encoded signal* (what the preview DOM,
// the GL stages and the native ffmpeg graph composite); these functions are pure RGB → RGB maps on encoded 0…1 values
// that every renderer bakes into the same LUT (ARCHITECTURE D-21), so preview and exports agree.
//
// Light units: R = cd/m² ÷ 203 (BT.2408 HDR reference white) for HDR and scene-referred light, R = relative display
// light (1 = SDR white) for SDR. SDR content entering an HDR space is mapped with its white at `sdrWhiteNits`
// (Premiere's "HDR Graphics White", BT.2408 default 203). Steps of an input transform:
//   1. decode the signal (camera logs via their domain and the file's range);
//   2. HLG: the BT.2100 OOTF of a 1000 cd/m² display (γ = 1.2); PQ: absolute luminance;
//   3. 3×3 gamut matrix (Bradford-adapted when the whites differ);
//   4. scene-referred sources: the BT.2100 reference OOTF Y^0.2 (γ = 1.2), so 18 % grey lands at 26 cd/m² (BT.2408 §5);
//   5. tone mapping (BT.2390 EETF on max RGB) when HDR/scene light enters an SDR working space ("Auto Tone Map",
//      target 203 cd/m² = SDR white) or exceeds an HLG working space's 1000 cd/m² peak;
//   6. gamut mapping when the source gamut is wider: ACES RGC for camera (scene) gamuts, luminance-preserving
//      desaturation for display gamuts (in-gamut colours come back exactly);
//   7. encode with the working curve (HLG: inverse OOTF, then the OETF), clamp to 0…1.
// Ported from FilmCraft `crates/color/src/{transform.rs,grade.rs}` (MIT OR Apache-2.0); steps 4 and the per-channel
// ACES RGC are additions (see docs/wp-notes/color-mgmt.md).
import type { Rgb } from '../lut.ts';
import { type GamutId, gamutLuma, gamutMatrix, gamutWithin } from './gamut.ts';
import {
	DEFAULT_HDR_PEAK_NITS,
	desaturateIntoGamut,
	gamutCompress,
	LOG_PEAK_NITS,
	REFERENCE_WHITE_NITS,
	toneMapNits,
} from './hdr.ts';
import { LOG_CURVES, type LogCurveId, logPeakLinear, signalFromNormalized } from './log.ts';
import { apply3InPlace, type ColorMatrix, isIdentity3 } from './matrix.ts';
import { type ColorSpaceDef, colorSpace, spaceLogDomain, type WorkingSpaceId } from './spaces.ts';
import {
	curveDecode,
	curveEncode,
	hlgDecode,
	hlgEncode,
	hlgSystemGamma,
	pqDecode,
	pqEncode,
} from './transfer.ts';

const RW = REFERENCE_WHITE_NITS;
const HLG_PEAK = DEFAULT_HDR_PEAK_NITS;
const HLG_GAMMA = hlgSystemGamma(HLG_PEAK);

/** The sequence colour settings the transforms need (defaults: `defaultWorkingSettings`). */
export type WorkingColorSettings = {
	space: WorkingSpaceId;
	/** SDR white in an HDR working space, cd/m² (Premiere's HDR Graphics White: 100, 203, 300). */
	sdrWhiteNits: number;
	/** PQ working space: the mastering peak tone-mapped from when the sequence is shown or exported as SDR. */
	hdrPeakNits: number;
	/** Tone map HDR and log media into an SDR working space (Auto Tone Map Media). */
	autoToneMap: boolean;
};

export function defaultWorkingSettings(space: WorkingSpaceId = 'rec709'): WorkingColorSettings {
	return { space, sdrWhiteNits: RW, hdrPeakNits: DEFAULT_HDR_PEAK_NITS, autoToneMap: true };
}

export type ColorFnRgb = (c: Rgb) => void;

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

function spaceOrThrow(id: string): ColorSpaceDef {
	const s = colorSpace(id);
	if (!s) throw new RangeError(`Unknown colour space "${id}"`);
	return s;
}

/** Per-channel decoder of a space's signal into its own linear light (see the module notes for units). */
function channelDecoder(s: ColorSpaceDef, range: 'tv' | 'pc'): (v: number) => number {
	const dom = spaceLogDomain(s);
	if (dom) {
		const c = LOG_CURVES[s.curve as LogCurveId];
		return (v) => c.decode(signalFromNormalized(v, range, dom));
	}
	switch (s.kind) {
		case 'pq':
			return (v) => (pqDecode(v) * 10000) / RW;
		case 'hlg':
			return (v) => hlgDecode(v < 0 ? 0 : v > 1 ? 1 : v);
		default:
			return (v) => curveDecode(s.curve, v);
	}
}

/** Source peak (cd/m²) of a space for tone mapping. */
function sourcePeakNits(s: ColorSpaceDef, peakNits: number | null | undefined): number {
	switch (s.kind) {
		case 'pq':
			return Math.min(10000, Math.max(RW, peakNits ?? DEFAULT_HDR_PEAK_NITS));
		case 'hlg':
			return HLG_PEAK;
		case 'scene': {
			const p = s.curve in LOG_CURVES ? logPeakLinear(s.curve as LogCurveId) : Number.POSITIVE_INFINITY;
			return Math.min(LOG_PEAK_NITS, Math.max(RW, RW * Math.max(0, p) ** HLG_GAMMA));
		}
		default:
			return RW;
	}
}

/** HLG OOTF in place: scene E (0..1) → R (cd/m² ÷ 203) on a 1000 cd/m² display. */
function hlgOotf(c: Rgb, luma: readonly [number, number, number]): void {
	const ys = Math.max(0, luma[0] * c[0] + luma[1] * c[1] + luma[2] * c[2]);
	const g = (HLG_PEAK / RW) * ys ** (HLG_GAMMA - 1);
	c[0] *= g;
	c[1] *= g;
	c[2] *= g;
}

/** Encoder of R (working units) into a space's signal, clamped to 0…1 (in place on the triple). */
function makeEncoder(s: ColorSpaceDef): (c: Rgb) => void {
	switch (s.kind) {
		case 'pq':
			return (c) => {
				for (let k = 0; k < 3; k++) c[k] = clamp01(pqEncode((Math.max(0, c[k]!) * RW) / 10000));
			};
		case 'hlg': {
			const l = gamutLuma(s.gamut);
			const k0 = RW / HLG_PEAK;
			const e = (1 - HLG_GAMMA) / HLG_GAMMA;
			return (c) => {
				const r = clamp01(c[0] * k0);
				const g = clamp01(c[1] * k0);
				const b = clamp01(c[2] * k0);
				const yd = l[0] * r + l[1] * g + l[2] * b;
				const k = yd > 1e-12 ? yd ** e : 0;
				c[0] = clamp01(hlgEncode(r * k));
				c[1] = clamp01(hlgEncode(g * k));
				c[2] = clamp01(hlgEncode(b * k));
			};
		}
		default:
			return (c) => {
				for (let k = 0; k < 3; k++) c[k] = clamp01(curveEncode(s.curve, clamp01(c[k]!)));
			};
	}
}

/** The scene-referred reference OOTF (γ = 1.2) on working-gamut RGB, in place. */
function sceneOotf(c: Rgb, luma: readonly [number, number, number]): void {
	const y = luma[0] * c[0] + luma[1] * c[1] + luma[2] * c[2];
	if (!(y > 0)) return;
	const g = y ** (HLG_GAMMA - 1);
	c[0] *= g;
	c[1] *= g;
	c[2] *= g;
}

export type InputSpec = {
	/** Source colour space id. */
	space: string;
	/** The file's range flag (limited `tv`, full `pc`); decides the log curves' domain conversion. */
	range?: 'tv' | 'pc';
	/** PQ content peak from the file's HDR metadata (cd/m²). */
	peakNits?: number | null;
	/** Override of the working settings' Auto Tone Map for this source (Interpret Footage). */
	toneMap?: boolean;
};

/** True when the input transform of `src` into `working` changes nothing. */
export function isIdentityInput(src: InputSpec, working: WorkingColorSettings): boolean {
	const s = spaceOrThrow(src.space);
	const w = spaceOrThrow(working.space);
	return (
		s.id === w.id || (s.kind === 'sdr' && w.kind === 'sdr' && s.gamut === w.gamut && s.curve === w.curve)
	);
}

/**
 * Source signal → working signal (null = identity). Throws `RangeError` for unknown space ids.
 */
export function inputTransformFn(src: InputSpec, working: WorkingColorSettings): ColorFnRgb | null {
	if (isIdentityInput(src, working)) return null;
	const s = spaceOrThrow(src.space);
	const w = spaceOrThrow(working.space);
	const dec = channelDecoder(s, src.range ?? 'tv');
	const m: ColorMatrix = gamutMatrix(s.gamut, w.gamut);
	const matrix = !isIdentity3(m);
	const srcLuma = gamutLuma(s.gamut);
	const wLuma = gamutLuma(w.gamut);
	const wHdr = w.kind === 'pq' || w.kind === 'hlg';
	const toneMap = src.toneMap ?? working.autoToneMap;
	const srcPeak = sourcePeakNits(s, src.peakNits);
	const sdrScale = wHdr && s.kind === 'sdr' ? Math.max(1, working.sdrWhiteNits) / RW : 1;
	// Target peak of tone mapping (cd/m²), or null for none.
	let target: number | null = null;
	if (s.kind !== 'sdr') {
		if (!wHdr) target = toneMap ? RW : null;
		else if (w.kind === 'hlg') target = HLG_PEAK;
	}
	const wider = !gamutWithin(s.gamut, w.gamut);
	const compress = wider && s.kind === 'scene';
	const desaturate = wider && s.kind !== 'scene';
	const enc = makeEncoder(w);
	const nits: Rgb = [0, 0, 0];
	return (c) => {
		c[0] = dec(c[0]);
		c[1] = dec(c[1]);
		c[2] = dec(c[2]);
		if (s.kind === 'hlg') hlgOotf(c, srcLuma);
		if (matrix) apply3InPlace(m, c);
		if (s.kind === 'scene') sceneOotf(c, wLuma);
		if (sdrScale !== 1) {
			c[0] *= sdrScale;
			c[1] *= sdrScale;
			c[2] *= sdrScale;
		}
		if (target !== null && target < srcPeak) {
			nits[0] = c[0] * RW;
			nits[1] = c[1] * RW;
			nits[2] = c[2] * RW;
			toneMapNits(nits, srcPeak, target);
			c[0] = nits[0] / RW;
			c[1] = nits[1] / RW;
			c[2] = nits[2] / RW;
		}
		if (compress) gamutCompress(c);
		else if (desaturate) desaturateIntoGamut(c, wLuma);
		enc(c);
	};
}

/** A synthetic SDR space (gamut + curve) for display transforms. */
function sdrSpace(gamut: GamutId, curve: ColorSpaceDef['curve']): ColorSpaceDef {
	return {
		id: `display:${gamut}:${curve}`,
		label: 'Display',
		group: 'Display',
		gamut,
		curve,
		kind: 'sdr',
		tags: null,
	};
}

/**
 * The space the Program monitor shows a working space in: an SDR working space keeps its own curve with Rec. 709
 * primaries (display colour management off, as Premiere's default), an HDR one is tone-mapped to Rec. 709 (BT.1886).
 */
export function displaySpaceFor(working: WorkingSpaceId): ColorSpaceDef {
	const w = spaceOrThrow(working);
	if (w.kind === 'sdr') return sdrSpace('bt709', w.curve);
	return spaceOrThrow('rec709');
}

/** Working signal → output signal (null = identity). `out` is an output space id or a display space. */
export function outputTransformFn(
	working: WorkingColorSettings,
	out: string | ColorSpaceDef,
	opts: { toneMap?: boolean } = {},
): ColorFnRgb | null {
	const w = spaceOrThrow(working.space);
	const o = typeof out === 'string' ? spaceOrThrow(out) : out;
	if (w.id === o.id || (w.kind === 'sdr' && o.kind === 'sdr' && w.gamut === o.gamut && w.curve === o.curve))
		return null;
	const dec = channelDecoder(w, 'pc');
	const m = gamutMatrix(w.gamut, o.gamut);
	const matrix = !isIdentity3(m);
	const wLuma = gamutLuma(w.gamut);
	const oLuma = gamutLuma(o.gamut);
	const wHdr = w.kind === 'pq' || w.kind === 'hlg';
	const oHdr = o.kind === 'pq' || o.kind === 'hlg';
	const sdrScale = !wHdr && oHdr ? Math.max(1, working.sdrWhiteNits) / RW : 1;
	const srcPeak = w.kind === 'pq' ? Math.min(10000, Math.max(RW, working.hdrPeakNits)) : HLG_PEAK;
	let target: number | null = null;
	if (wHdr && !oHdr) target = (opts.toneMap ?? true) ? RW : null;
	else if (wHdr && o.kind === 'hlg') target = HLG_PEAK;
	const desaturate = !gamutWithin(w.gamut, o.gamut);
	const enc = makeEncoder(o);
	const nits: Rgb = [0, 0, 0];
	return (c) => {
		c[0] = dec(c[0]);
		c[1] = dec(c[1]);
		c[2] = dec(c[2]);
		if (w.kind === 'hlg') hlgOotf(c, wLuma);
		if (matrix) apply3InPlace(m, c);
		if (sdrScale !== 1) {
			c[0] *= sdrScale;
			c[1] *= sdrScale;
			c[2] *= sdrScale;
		}
		if (target !== null && target < srcPeak) {
			nits[0] = c[0] * RW;
			nits[1] = c[1] * RW;
			nits[2] = c[2] * RW;
			toneMapNits(nits, srcPeak, target);
			c[0] = nits[0] / RW;
			c[1] = nits[1] / RW;
			c[2] = nits[2] / RW;
		}
		if (desaturate) desaturateIntoGamut(c, oLuma);
		enc(c);
	};
}

/** Default HDR White / curve HDR Range (cd/m²). */
/**
 * spec 19 TL-116: a working signal in the output space's linear light with nothing mapped: no tone mapping, no gamut
 * compression, so a colour the output cannot hold stays outside `[0, peak]`. `peak` is the output's top in the same
 * unit (1 = SDR white; `Infinity` when the output tone maps what is above it, which is range, not gamut).
 */
export function unmappedOutputFn(
	working: WorkingColorSettings,
	out: string | ColorSpaceDef,
): { fn: ColorFnRgb; peak: number } {
	const w = spaceOrThrow(working.space);
	const o = typeof out === 'string' ? spaceOrThrow(out) : out;
	const dec = channelDecoder(w, 'pc');
	const m = gamutMatrix(w.gamut, o.gamut);
	const wLuma = gamutLuma(w.gamut);
	const wHdr = w.kind === 'pq' || w.kind === 'hlg';
	const oHdr = o.kind === 'pq' || o.kind === 'hlg';
	const sdrScale = !wHdr && oHdr ? Math.max(1, working.sdrWhiteNits) / RW : 1;
	const peak =
		o.kind === 'pq'
			? Math.min(10000, Math.max(RW, working.hdrPeakNits)) / RW
			: oHdr
				? HLG_PEAK / RW
				: wHdr
					? Number.POSITIVE_INFINITY
					: 1;
	return {
		peak,
		fn: (c) => {
			c[0] = dec(c[0]);
			c[1] = dec(c[1]);
			c[2] = dec(c[2]);
			if (w.kind === 'hlg') hlgOotf(c, wLuma);
			apply3InPlace(m, c);
			c[0] *= sdrScale;
			c[1] *= sdrScale;
			c[2] *= sdrScale;
		},
	};
}

export const DEFAULT_HDR_WHITE_NITS = 1000;

/**
 * Lumetri's grading signal in an HDR working space (FilmCraft `grade.rs`): the working signal re-expressed so that 1.0
 * is HDR White `white` cd/m² (PQ: the PQ signal ÷ PQ(white); HLG: the HLG signal of a display of peak `white`, system
 * gamma 1.2 + 0.42·log10(white/1000)). Values above HDR White (speculars) are > 1. Null for SDR working spaces
 * (grading works on the working signal directly).
 */
export function gradeSpace(
	working: WorkingSpaceId,
	whiteNits: number,
): { toGrade(c: Rgb): void; fromGrade(c: Rgb): void } | null {
	const w = spaceOrThrow(working);
	const white = Math.min(
		10000,
		Math.max(100, Number.isFinite(whiteNits) ? whiteNits : DEFAULT_HDR_WHITE_NITS),
	);
	if (w.kind === 'pq') {
		const norm = pqEncode(white / 10000);
		return {
			toGrade(c) {
				c[0] /= norm;
				c[1] /= norm;
				c[2] /= norm;
			},
			fromGrade(c) {
				for (let k = 0; k < 3; k++) c[k] = clamp01(Math.max(0, c[k]!) * norm);
			},
		};
	}
	if (w.kind === 'hlg') {
		const l = gamutLuma(w.gamut);
		const gw = hlgSystemGamma(white);
		const ew = (1 - gw) / gw;
		const fd: Rgb = [0, 0, 0];
		return {
			// working HLG (1000 cd/m² display) → display light → HLG of a `white` display
			toGrade(c) {
				for (let k = 0; k < 3; k++) fd[k] = hlgDecode(clamp01(c[k]!));
				hlgOotf(fd, l); // R units
				for (let k = 0; k < 3; k++) fd[k] = (Math.max(0, fd[k]!) * RW) / white;
				const yd = l[0] * fd[0] + l[1] * fd[1] + l[2] * fd[2];
				if (!(yd > 0)) {
					c[0] = 0;
					c[1] = 0;
					c[2] = 0;
					return;
				}
				const k = yd ** ew;
				for (let j = 0; j < 3; j++) c[j] = hlgEncode(fd[j]! * k);
			},
			fromGrade(c) {
				for (let k = 0; k < 3; k++) fd[k] = hlgDecode(Math.min(1.5, Math.max(0, c[k]!)));
				const ys = l[0] * fd[0] + l[1] * fd[1] + l[2] * fd[2];
				if (!(ys > 0)) {
					c[0] = 0;
					c[1] = 0;
					c[2] = 0;
					return;
				}
				const g = ys ** (gw - 1) * (white / RW);
				for (let k = 0; k < 3; k++) c[k] = fd[k]! * g;
				// R units → working HLG (1000 cd/m² display)
				const k0 = RW / HLG_PEAK;
				const r = clamp01(c[0] * k0);
				const gg = clamp01(c[1] * k0);
				const b = clamp01(c[2] * k0);
				const yd = l[0] * r + l[1] * gg + l[2] * b;
				const kk = yd > 1e-12 ? yd ** ((1 - HLG_GAMMA) / HLG_GAMMA) : 0;
				c[0] = clamp01(hlgEncode(r * kk));
				c[1] = clamp01(hlgEncode(gg * kk));
				c[2] = clamp01(hlgEncode(b * kk));
			},
		};
	}
	return null;
}

/** cd/m² of a working signal grey (scopes' nits scale): PQ absolute, HLG on a 1000 cd/m² display, SDR × sdrWhite. */
export function nitsOfWorkingSignal(working: WorkingSpaceId, v: number, sdrWhiteNits = 100): number {
	const w = spaceOrThrow(working);
	if (w.kind === 'pq') return pqDecode(v) * 10000;
	if (w.kind === 'hlg') return HLG_PEAK * hlgDecode(clamp01(v)) ** HLG_GAMMA;
	return Math.max(0, curveDecode(w.curve, clamp01(v))) * sdrWhiteNits;
}

/** Working signal of a grey of `nits` cd/m² (inverse of `nitsOfWorkingSignal`). */
export function workingSignalOfNits(working: WorkingSpaceId, nits: number, sdrWhiteNits = 100): number {
	const w = spaceOrThrow(working);
	const n = Math.max(0, nits);
	if (w.kind === 'pq') return pqEncode(n / 10000);
	if (w.kind === 'hlg') return hlgEncode((n / HLG_PEAK) ** (1 / HLG_GAMMA));
	return clamp01(curveEncode(w.curve, n / sdrWhiteNits));
}
